//! Authorized calls to the Gmail REST API. The access token lives only in memory. A call
//! refused with 401 refreshes it once and tries again, so the adapter never reads a clock
//! to guess when a token expires. The handle-errors guide prescribes exactly that:
//! https://developers.google.com/gmail/api/guides/handle-errors#401_invalid_credentials

use std::cell::RefCell;

use letterbox_core::adapter::AdapterFailure;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::config::GmailConfig;
use crate::oauth;
use crate::wire::ApiError;

/// Why a call returned no value.
#[derive(Debug)]
pub enum CallError {
    /// The provider was not reached, or not with valid credentials.
    Failure(AdapterFailure),
    /// The provider answered with an error status. Each caller decides what that means.
    Status { status: StatusCode, reason: String },
}

impl CallError {
    /// True for 404, which every caller reads as "that thing is gone".
    pub fn is_not_found(&self) -> bool {
        matches!(self, CallError::Status { status, .. } if *status == StatusCode::NOT_FOUND)
    }

    /// The failure to report when the caller has no better reading of the status. A 403
    /// that is a rate limit, a 429 and a 5xx are all worth retrying later.
    pub fn failure(&self) -> AdapterFailure {
        match self {
            CallError::Failure(failure) => *failure,
            CallError::Status { .. } => AdapterFailure::ProviderError,
        }
    }
}

/// One account's connection to the API.
pub struct Api {
    http: reqwest::Client,
    config: GmailConfig,
    refresh_token: String,
    access_token: RefCell<Option<String>>,
}

impl Api {
    /// `access_token` is the one the sign-in got, or None after a restart.
    pub fn new(
        http: reqwest::Client,
        config: GmailConfig,
        refresh_token: String,
        access_token: Option<String>,
    ) -> Self {
        Api {
            http,
            config,
            refresh_token,
            access_token: RefCell::new(access_token),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}/gmail/v1/users/me/{path}", self.config.api_base)
    }

    async fn fresh_token(&self) -> Result<String, AdapterFailure> {
        let token = oauth::refresh(&self.http, &self.config, &self.refresh_token).await?;
        *self.access_token.borrow_mut() = Some(token.clone());
        Ok(token)
    }

    /// Sends the request `build` makes, refreshing the token once on a 401.
    async fn send(&self, build: impl Fn(&reqwest::Client) -> RequestBuilder) -> Result<Response, CallError> {
        let held = self.access_token.borrow().clone();
        let token = match held {
            Some(token) => token,
            None => self.fresh_token().await.map_err(CallError::Failure)?,
        };
        let offline = |_| CallError::Failure(AdapterFailure::Offline);
        let response = build(&self.http).bearer_auth(&token).send().await.map_err(offline)?;
        let response = if response.status() == StatusCode::UNAUTHORIZED {
            let token = self.fresh_token().await.map_err(CallError::Failure)?;
            build(&self.http).bearer_auth(&token).send().await.map_err(offline)?
        } else {
            response
        };
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        if status == StatusCode::UNAUTHORIZED {
            // A fresh token was refused too. The grant no longer covers this call.
            return Err(CallError::Failure(AdapterFailure::NeedsSignIn));
        }
        let body: ApiError = response.json().await.unwrap_or_default();
        let reason = body
            .error
            .errors
            .into_iter()
            .next()
            .map(|item| item.reason)
            .unwrap_or_default();
        Err(CallError::Status { status, reason })
    }

    /// Reads a success body. One that is not the expected JSON is the provider's error.
    async fn read<T: DeserializeOwned>(response: Response) -> Result<T, CallError> {
        response
            .json()
            .await
            .map_err(|_| CallError::Failure(AdapterFailure::ProviderError))
    }

    /// GET `users/me/<path>` with a query.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T, CallError> {
        let url = self.url(path);
        Self::read(self.send(|http| http.get(&url).query(query)).await?).await
    }

    /// POST `users/me/<path>` with a JSON body. The response body, if any, is ignored.
    pub async fn post(&self, path: &str, body: &impl Serialize) -> Result<(), CallError> {
        let url = self.url(path);
        self.send(|http| http.post(&url).json(body)).await.map(drop)
    }
}
