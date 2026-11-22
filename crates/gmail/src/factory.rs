//! Signing in to Gmail, and rebuilding an adapter after a restart.

use std::cell::Cell;
use std::rc::Rc;

use letterbox_core::adapter::{
    Adapter, AdapterFactory, Connection, FactoryOption, LocalFuture, SignInFailure, SignInInput,
};
use letterbox_protocol::SignInMethod;
use serde::{Deserialize, Serialize};

use crate::adapter::GmailAdapter;
use crate::api::Api;
use crate::config::GmailConfig;
use crate::loopback::{self, Redirect};
use crate::oauth::{self, Pkce};
use crate::wire::Profile;

/// What `resume` needs. The session string is this as JSON. It holds a refresh token,
/// which is why the core must keep session strings in the system keychain.
#[derive(Serialize, Deserialize)]
struct Session {
    address: String,
    refresh_token: String,
    /// Whether the user granted the modify scope.
    modify: bool,
}

pub struct GmailFactory {
    config: GmailConfig,
    http: reqwest::Client,
    option: FactoryOption,
    /// Sign-in attempts so far. Picks the port for `Loopback::Unix`.
    attempts: Cell<u16>,
}

impl GmailFactory {
    /// The host's tokio runtime must have its time driver on (`enable_time`): the HTTP
    /// client starts a timer when a name has both IPv6 and IPv4 addresses, as Google's do, and
    /// one for each request's budget (`GmailConfig::timeouts`). The adapter's own code never
    /// waits on a timer (clippy.toml).
    pub fn new(config: GmailConfig) -> Self {
        let http = config
            .hosts
            .iter()
            .fold(reqwest::Client::builder(), |builder, (name, addresses)| {
                builder.resolve_to_addrs(name, addresses)
            })
            // Every request's budget unless it sets its own: a transfer does (see api.rs).
            .timeout(config.timeouts.call)
            .build()
            .expect("an HTTP client with rustls builds");
        GmailFactory {
            config,
            http,
            option: FactoryOption {
                id: "gmail".to_owned(),
                label: "Gmail".to_owned(),
                method: SignInMethod::Oauth,
            },
            attempts: Cell::new(0),
        }
    }

    fn adapter(&self, refresh_token: String, access_token: Option<String>, modify: bool) -> GmailAdapter {
        GmailAdapter {
            api: Api::new(self.http.clone(), self.config.clone(), refresh_token, access_token),
            modify,
        }
    }

    /// One attempt: listen, show consent, wait for the redirect, trade the code, read the address.
    async fn sign_in(&self, open_url: &dyn Fn(String)) -> Result<Connection, SignInFailure> {
        let attempt = self.attempts.get();
        self.attempts.set(attempt.wrapping_add(1));
        let listening = loopback::listen(&self.config.loopback, attempt)
            .await
            .map_err(|_| SignInFailure::Offline)?;
        let pkce = Pkce::new(&self.config);
        open_url(oauth::consent_url(&self.config, &listening.redirect_uri, &pkce));
        let redirect = listening
            .redirect(&pkce.state)
            .await
            .map_err(|_| SignInFailure::Offline)?;
        let Redirect::Code(code) = redirect else {
            return Err(SignInFailure::Denied);
        };
        let redirect_uri = listening.redirect_uri.clone();
        drop(listening);

        let tokens = oauth::exchange(&self.http, &self.config, &code, &pkce, &redirect_uri).await?;
        // Without a refresh token the account could not survive a restart.
        let refresh_token = tokens.refresh_token.ok_or(SignInFailure::Denied)?;
        let modify = oauth::can_modify(&tokens.scope);
        let adapter = self.adapter(refresh_token.clone(), Some(tokens.access_token), modify);
        let profile: Profile = adapter
            .api
            .get("profile", &[])
            .await
            .map_err(|_| SignInFailure::Offline)?;
        let session = Session {
            address: profile.email_address.clone(),
            refresh_token,
            modify,
        };
        Ok(Connection {
            address: profile.email_address,
            provider_label: "Gmail".to_owned(),
            adapter: Rc::new(adapter),
            session: serde_json::to_string(&session).expect("sessions are plain data"),
        })
    }
}

impl AdapterFactory for GmailFactory {
    fn option(&self) -> &FactoryOption {
        &self.option
    }

    fn connect(&self, input: SignInInput) -> LocalFuture<'_, Result<Connection, SignInFailure>> {
        Box::pin(async move {
            if input.signal.is_cancelled() {
                return Err(SignInFailure::Cancelled);
            }
            tokio::select! {
                () = input.signal.cancelled() => Err(SignInFailure::Cancelled),
                result = self.sign_in(input.open_url.as_ref()) => result,
            }
        })
    }

    fn resume(&self, session: &str) -> Rc<dyn Adapter> {
        let session: Session = serde_json::from_str(session).expect("gmail: not a session string from this adapter");
        Rc::new(self.adapter(session.refresh_token, None, session.modify))
    }
}
