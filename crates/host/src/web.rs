//! The `Web` both programs give the core (crates/core/src/web.rs): one https GET per call,
//! over reqwest with rustls. It follows no redirect, sends no referrer, keeps no cookies (the
//! client has no cookie store) and sends no credentials, and stops reading a body at the limit.

use std::time::Duration;

use letterbox_core::adapter::LocalFuture;
use letterbox_core::web::{Fetched, Web};
use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;

/// How long one image request may take, start to end.
const TIMEOUT: Duration = Duration::from_secs(20);

pub struct HttpsWeb {
    client: reqwest::Client,
    /// Where core-sim sends every request instead, over plain http: `https://host/path?q`
    /// goes to `<route>/host/path?q` (the harness's fake web). None for a person's app.
    route: Option<String>,
}

impl HttpsWeb {
    pub fn new(route: Option<String>) -> HttpsWeb {
        let client = reqwest::Client::builder()
            .redirect(Policy::none())
            .referer(false)
            .timeout(TIMEOUT)
            .build()
            .expect("a client with rustls and no redirects builds");
        HttpsWeb { client, route }
    }

    async fn fetch(&self, url: &str, limit: usize) -> Fetched {
        let target = match (&self.route, url.strip_prefix("https://")) {
            (None, _) => url.to_owned(),
            (Some(route), Some(rest)) => format!("{}/{rest}", route.trim_end_matches('/')),
            (Some(_), None) => return Fetched::Failed,
        };
        let Ok(mut response) = self.client.get(target).send().await else {
            return Fetched::Failed;
        };
        let status = response.status();
        if status.is_redirection() {
            let location = response.headers().get(LOCATION).and_then(|value| value.to_str().ok());
            return location.map_or(Fetched::Failed, |location| Fetched::Redirect {
                location: location.to_owned(),
            });
        }
        if !status.is_success() {
            return Fetched::Failed;
        }
        let mime = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_default();
        let mut bytes = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if bytes.len() + chunk.len() > limit => return Fetched::TooLarge,
                Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                Ok(None) => return Fetched::Body { mime, bytes },
                Err(_) => return Fetched::Failed,
            }
        }
    }
}

impl Web for HttpsWeb {
    fn get(&self, url: &str, limit: usize) -> LocalFuture<'_, Fetched> {
        let url = url.to_owned();
        Box::pin(async move { self.fetch(&url, limit).await })
    }
}
