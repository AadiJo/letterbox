//! OAuth 2.0 for installed apps, as Google describes it at
//! https://developers.google.com/identity/protocols/oauth2/native-app: PKCE with S256,
//! a consent URL, and the token endpoint for the code exchange and for refreshes.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use letterbox_core::adapter::{AdapterFailure, SignInFailure};
use sha2::{Digest, Sha256};

use crate::config::GmailConfig;
use crate::wire::{TokenError, Tokens};

/// "Read, compose, and send emails", with no way to delete past the trash. The narrowest
/// scope that can change labels. https://developers.google.com/gmail/api/auth/scopes
pub const MODIFY_SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";
/// Full access. It covers everything the modify scope does.
const FULL_SCOPE: &str = "https://mail.google.com/";

/// One sign-in attempt's secrets: the PKCE verifier stays here, the challenge and state go in the URL.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    /// Two draws of 32 bytes. Each encodes to 43 base64url characters, the least the
    /// guide allows for a verifier. code_challenge = BASE64URL(SHA256(verifier)).
    pub fn new(config: &GmailConfig) -> Self {
        let verifier = URL_SAFE_NO_PAD.encode((config.random)());
        let state = URL_SAFE_NO_PAD.encode((config.random)());
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Pkce {
            verifier,
            challenge,
            state,
        }
    }
}

/// The page the user opens to grant access.
pub fn consent_url(config: &GmailConfig, redirect_uri: &str, pkce: &Pkce) -> String {
    let params = [
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", MODIFY_SCOPE),
        ("code_challenge", &pkce.challenge),
        ("code_challenge_method", "S256"),
        ("state", &pkce.state),
    ];
    reqwest::Url::parse_with_params(&config.auth_url, params)
        .map(String::from)
        .unwrap_or_else(|error| panic!("gmail: auth_url {:?} is not a URL: {error}", config.auth_url))
}

/// True when the granted scopes let the adapter change mail. A user can grant fewer scopes than asked.
pub fn can_modify(scope: &str) -> bool {
    scope
        .split(' ')
        .any(|granted| granted == MODIFY_SCOPE || granted == FULL_SCOPE)
}

/// Why the token endpoint gave no tokens.
enum TokenFailure {
    /// The request never got an answer.
    Unreachable,
    /// `invalid_grant`: the code or refresh token is expired, revoked or already used.
    InvalidGrant,
    /// Any other refusal or a server error.
    Other,
}

/// Posts one form to the token endpoint, with the client's credentials added.
async fn token_request(
    http: &reqwest::Client,
    config: &GmailConfig,
    fields: &[(&str, &str)],
) -> Result<Tokens, TokenFailure> {
    let mut form: Vec<(&str, &str)> = vec![("client_id", &config.client_id)];
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret", secret));
    }
    form.extend_from_slice(fields);
    let response = http
        .post(&config.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|_| TokenFailure::Unreachable)?;
    let status = response.status();
    if status.is_success() {
        return response.json().await.map_err(|_| TokenFailure::Other);
    }
    if status.is_server_error() {
        return Err(TokenFailure::Other);
    }
    let body: TokenError = response.json().await.unwrap_or_default();
    Err(if body.error == "invalid_grant" {
        TokenFailure::InvalidGrant
    } else {
        TokenFailure::Other
    })
}

/// Trades the code from the redirect for tokens.
pub async fn exchange(
    http: &reqwest::Client,
    config: &GmailConfig,
    code: &str,
    pkce: &Pkce,
    redirect_uri: &str,
) -> Result<Tokens, SignInFailure> {
    let fields = [
        ("code", code),
        ("code_verifier", pkce.verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    token_request(http, config, &fields)
        .await
        .map_err(|failure| match failure {
            TokenFailure::Unreachable => SignInFailure::Offline,
            // The user did consent, but Google would not finish the grant. There is no closer answer.
            TokenFailure::InvalidGrant | TokenFailure::Other => SignInFailure::Denied,
        })
}

/// Gets a new access token. A refresh token refused for good means the user must sign in again.
/// https://developers.google.com/identity/protocols/oauth2/native-app#offline
pub async fn refresh(
    http: &reqwest::Client,
    config: &GmailConfig,
    refresh_token: &str,
) -> Result<String, AdapterFailure> {
    let fields = [("grant_type", "refresh_token"), ("refresh_token", refresh_token)];
    match token_request(http, config, &fields).await {
        Ok(tokens) => Ok(tokens.access_token),
        Err(TokenFailure::Unreachable) => Err(AdapterFailure::Offline),
        Err(TokenFailure::InvalidGrant) => Err(AdapterFailure::NeedsSignIn),
        Err(TokenFailure::Other) => Err(AdapterFailure::ProviderError),
    }
}
