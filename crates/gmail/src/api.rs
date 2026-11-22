//! Authorized calls to the Gmail REST API. The access token lives only in memory. A call
//! refused with 401 refreshes it once and tries again, so the adapter never reads a clock
//! to guess when a token expires. The handle-errors guide prescribes exactly that:
//! https://developers.google.com/gmail/api/guides/handle-errors#401_invalid_credentials
//!
//! A call refused as over a rate limit waits and goes again, as the same guide says to:
//! "Use exponential backoff to retry the request." The per-user limit is counted in quota
//! units per minute, https://developers.google.com/workspace/gmail/api/reference/quota, so
//! one big sync can reach it. Every call goes through `send`, so every call waits the same way.
//! A daily limit is answered at once: waiting minutes does not bring it back.

use std::cell::RefCell;
use std::time::Duration;

use letterbox_core::adapter::AdapterFailure;
use reqwest::header::RETRY_AFTER;
use reqwest::{RequestBuilder, Response, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

use crate::config::GmailConfig;
use crate::oauth;
use crate::wire::ApiError;

/// 403 reasons the handle-errors guide says to retry with exponential backoff:
/// https://developers.google.com/workspace/gmail/api/guides/handle-errors#rate-limit and
/// #user-rate-limit. A 429 is retried too, by its status (#429-errors).
const RATE_LIMITS: [&str; 2] = ["rateLimitExceeded", "userRateLimitExceeded"];
/// The 403 reason for a project over its quota. The guide's fix is to "raise the quota in the
/// Google Cloud project" (#daily-limit), which no wait does, so it is not retried.
const DAILY_LIMIT: &str = "dailyLimitExceeded";
/// The guide: "Start retry periods at least one second after the error."
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
/// Backoff doubles up to this. A minute is the window of the per-user limit.
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// After this many rate-limited answers in a row, one call gives up with the last one.
/// The seven waits before it add up to 123 seconds when Gmail names none.
const RATE_LIMIT_TRIES: u32 = 8;

/// Why a call returned no value.
#[derive(Debug)]
pub enum CallError {
    /// The provider was not reached, or not with valid credentials. A request that fails
    /// this way surely did not reach Gmail, or Gmail refused it before acting on it.
    Failure(AdapterFailure),
    /// The request went out, then the connection failed before an answer came back, so the
    /// provider may have acted on it. Only a send needs to tell this apart (see send.rs).
    /// Every other caller reads it as offline.
    Lost,
    /// Gmail answered with success, but its body could not be read whole, or was not the
    /// JSON expected. Gmail acted on the call. Every caller but a send reads it as Gmail's error.
    Unreadable,
    /// The provider answered with an error status. Each caller decides what that means.
    Status { status: StatusCode, reason: String },
}

impl CallError {
    /// True for a 429, or a 403 whose reason is a rate limit. Either is worth retrying soon.
    pub fn is_rate_limit(&self) -> bool {
        match self {
            CallError::Status { status, reason } => {
                *status == StatusCode::TOO_MANY_REQUESTS
                    || (*status == StatusCode::FORBIDDEN && RATE_LIMITS.contains(&reason.as_str()))
            }
            CallError::Failure(_) | CallError::Lost | CallError::Unreadable => false,
        }
    }

    /// True for a rate limit or a daily limit: Gmail refused the call for usage, not
    /// permission, so it may go through later.
    pub fn is_usage_limit(&self) -> bool {
        self.is_rate_limit()
            || matches!(self, CallError::Status { status, reason } if *status == StatusCode::FORBIDDEN && reason == DAILY_LIMIT)
    }

    /// True for 404, which every caller reads as "that thing is gone".
    pub fn is_not_found(&self) -> bool {
        matches!(self, CallError::Status { status, .. } if *status == StatusCode::NOT_FOUND)
    }

    /// The failure to report when the caller has no better reading of the status. A usage
    /// limit `send` stopped waiting out or did not wait out, and a 5xx, are all worth retrying later.
    pub fn failure(&self) -> AdapterFailure {
        match self {
            CallError::Failure(failure) => *failure,
            CallError::Lost => AdapterFailure::Offline,
            CallError::Unreadable => AdapterFailure::ProviderError,
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
    /// Cancelled when the adapter closes. A rate-limit wait then ends at once.
    closed: CancellationToken,
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
            closed: CancellationToken::new(),
        }
    }

    /// Ends every rate-limit wait, now and later. A call that was waiting answers offline.
    pub fn close(&self) {
        self.closed.cancel();
    }

    fn url(&self, path: &str) -> String {
        format!("{}/gmail/v1/users/me/{path}", self.config.api_base)
    }

    async fn fresh_token(&self) -> Result<String, AdapterFailure> {
        let token = oauth::refresh(&self.http, &self.config, &self.refresh_token).await?;
        *self.access_token.borrow_mut() = Some(token.clone());
        Ok(token)
    }

    /// Sends the request `build` makes, within `budget` each time (see `Timeouts`). A rate-limited answer is sent again after a wait: the
    /// seconds a Retry-After header names, else a backoff from FIRST_BACKOFF that doubles up
    /// to MAX_BACKOFF. After RATE_LIMIT_TRIES of them in a row the call answers with the last.
    /// A Retry-After given as a date is read as absent, since the adapter reads no clock.
    async fn send(
        &self,
        budget: Duration,
        build: impl Fn(&reqwest::Client) -> RequestBuilder,
    ) -> Result<Response, CallError> {
        let build = |http: &reqwest::Client| build(http).timeout(budget);
        let mut backoff = FIRST_BACKOFF;
        let mut refused = 0;
        loop {
            let response = self.send_once(&build).await?;
            if response.status().is_success() {
                return Ok(response);
            }
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok()?.trim().parse().ok())
                .map(Duration::from_secs);
            let error = Self::error_of(response).await;
            refused += 1;
            if !error.is_rate_limit() || refused == RATE_LIMIT_TRIES {
                return Err(error);
            }
            let wait = retry_after.unwrap_or(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
            // Biased, so a close that came first wins even when the pause would end at once.
            tokio::select! {
                biased;
                () = self.closed.cancelled() => return Err(CallError::Failure(AdapterFailure::Offline)),
                () = (self.config.pause)(wait) => {}
            }
        }
    }

    /// Sends the request once, refreshing the token once on a 401. Any other status comes back as it is.
    async fn send_once(&self, build: &impl Fn(&reqwest::Client) -> RequestBuilder) -> Result<Response, CallError> {
        let held = self.access_token.borrow().clone();
        let token = match held {
            Some(token) => token,
            None => self.fresh_token().await.map_err(CallError::Failure)?,
        };
        // A connection that was never made surely carried nothing. Any later failure may have,
        // a request past its budget included.
        let offline = |error: reqwest::Error| {
            if error.is_connect() {
                CallError::Failure(AdapterFailure::Offline)
            } else {
                CallError::Lost
            }
        };
        let response = build(&self.http).bearer_auth(&token).send().await.map_err(offline)?;
        let response = if response.status() == StatusCode::UNAUTHORIZED {
            let token = self.fresh_token().await.map_err(CallError::Failure)?;
            build(&self.http).bearer_auth(&token).send().await.map_err(offline)?
        } else {
            response
        };
        if response.status() == StatusCode::UNAUTHORIZED {
            // A fresh token was refused too. The grant no longer covers this call.
            return Err(CallError::Failure(AdapterFailure::NeedsSignIn));
        }
        Ok(response)
    }

    /// Reads an error answer's status and its first reason. An error body the request's budget
    /// cut off is `Lost`: without its reason the status says nothing sure, and the call may
    /// have landed. Any other body that cannot be read leaves the status with no reason.
    async fn error_of(response: Response) -> CallError {
        let status = response.status();
        let body: ApiError = match response.json().await {
            Ok(body) => body,
            Err(error) if error.is_timeout() => return CallError::Lost,
            Err(_) => ApiError::default(),
        };
        let reason = body
            .error
            .errors
            .into_iter()
            .next()
            .map(|item| item.reason)
            .unwrap_or_default();
        CallError::Status { status, reason }
    }

    /// Reads a success body: cut off, or not the expected JSON, it is `Unreadable`. One the
    /// request's budget cut off is `Lost`: the connection stalled, as one that drops does.
    async fn read<T: DeserializeOwned>(response: Response) -> Result<T, CallError> {
        response.json().await.map_err(|error| {
            if error.is_timeout() {
                CallError::Lost
            } else {
                CallError::Unreadable
            }
        })
    }

    /// GET `users/me/<path>` with a query, within the call budget.
    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T, CallError> {
        let url = self.url(path);
        Self::read(
            self.send(self.config.timeouts.call, |http| http.get(&url).query(query))
                .await?,
        )
        .await
    }

    /// GET `users/me/<path>`, within the transfer budget: an attachment's download.
    pub async fn get_transfer<T: DeserializeOwned>(&self, path: &str) -> Result<T, CallError> {
        let url = self.url(path);
        Self::read(self.send(self.config.timeouts.transfer, |http| http.get(&url)).await?).await
    }

    /// POST `users/me/<path>` with a JSON body, within the transfer budget, and read the
    /// answer: a send's upload.
    pub async fn post_transfer_for<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, CallError> {
        let url = self.url(path);
        Self::read(
            self.send(self.config.timeouts.transfer, |http| http.post(&url).json(body))
                .await?,
        )
        .await
    }

    /// POST `users/me/<path>` with a JSON body, within the call budget. The response body, if any, is ignored.
    pub async fn post(&self, path: &str, body: &impl Serialize) -> Result<(), CallError> {
        let url = self.url(path);
        self.send(self.config.timeouts.call, |http| http.post(&url).json(body))
            .await
            .map(drop)
    }
}
