//! The check RFC 8058 section 4 asks for before a one-click POST: the message carries a DKIM
//! signature (RFC 6376) that verifies, and whose `h=` covers From, List-Unsubscribe and
//! List-Unsubscribe-Post. The core asks one thing more: the signature's `d=` aligns with the
//! From domain the user sees, so a list run by one domain cannot vouch for a URL in mail that
//! shows another's From. It runs once per unsubscribe, on the raw source the provider holds,
//! never when mail is read.
//!
//! Every field is read as the verifier reads it, from mail-auth's own list of the message's
//! fields: by its name as written, compared without case. The URL comes from the raw source's
//! List-Unsubscribe and List-Unsubscribe-Post, not from what the adapter reported, and only when
//! the message holds exactly one of each, and one From: a signature covers the last instance of
//! a field it names, so with a second one a reader could take the unsigned one. A URL with a
//! user name or password is refused too, since it would go out as an Authorization header.
//!
//! The verifying is mail-auth's, the library Stalwart's mail server verifies with: it does the
//! canonicalization, the body hash, the key record and the RSA or Ed25519 check. Its DNS lookups
//! go through the host's `Web` instead of its own resolver. The core looks up the key record of
//! each signature it could use, at most MAX_SIGNATURES of them, and hands mail-auth the answers
//! as its cache. Its resolver has no servers, so any other name it asks for, such as an RFC 6541
//! ATPS record, fails as a DNS error, which fails that signature. The only other thing it reads
//! from outside is the wall clock, for a signature's `x=` expiry.

use std::cell::RefCell;
use std::collections::HashMap;
use std::hash::Hash;

use letterbox_protocol::Unsubscribe;
use mail_auth::dkim::{DomainKey, Signature};
use mail_auth::dns::TxtRecordParser;
use mail_auth::hickory_resolver::config::{ResolverConfig, ResolverOpts};
use mail_auth::{
    AuthenticatedMessage, DkimResult, DnsCache, MessageAuthenticator, NoCache, Parameters, ResolverCache, TxtRecord,
};
use url::Url;

use crate::adapter::RemoteHeaders;
use crate::body::unsubscribe::from_headers;
use crate::web::{Txt, Web};

/// The most signatures whose keys the core looks up. A message rarely carries more than two:
/// its author's domain and the service that sent it.
const MAX_SIGNATURES: usize = 4;

/// The one-click URL `raw` vouches for, from a sender whose From address is in `from_domain`,
/// or None when no signature that covers the fields it needs verifies and aligns, or the signed
/// fields name no one-click URL a POST may go to. See the module docs.
pub async fn one_click(raw: &[u8], from_domain: &str, web: &dyn Web) -> Option<String> {
    let message = AuthenticatedMessage::parse(raw)?;
    // Each field as the verifier finds it: by its name as written, compared without case. A
    // name written another way, as `List-Unsubscribe :`, is another field, which no signature
    // that names List-Unsubscribe covers.
    let named = |name: &str| -> Vec<String> {
        let found = message
            .headers()
            .iter()
            .filter(|(found, _)| found.eq_ignore_ascii_case(name.as_bytes()));
        found
            .map(|(_, value)| String::from_utf8_lossy(value).into_owned())
            .collect()
    };
    let (list, post) = (named("List-Unsubscribe"), named("List-Unsubscribe-Post"));
    let ([list], [post], [_]) = (&list[..], &post[..], &named("From")[..]) else {
        return None;
    };
    let signed = RemoteHeaders {
        list_unsubscribe: true,
        list_id: false,
        precedence: String::new(),
        auto_submitted: String::new(),
        list_unsubscribe_value: list.clone(),
        list_unsubscribe_post: post.clone(),
    };
    let Some(Unsubscribe::OneClick { url, .. }) = from_headers(&signed) else {
        return None;
    };
    // A user name or password in the URL would go out as an Authorization header, which RFC
    // 8058 section 3.1 forbids.
    let parsed = Url::parse(&url).ok()?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    let from_domain = from_domain.trim_end_matches('.').to_ascii_lowercase();
    let usable = |signature: &Signature| covers(signature) && aligned(signature, &from_domain);
    let candidates = message.dkim_signatures().iter().map(|found| &found.header);
    let covering: Vec<&Signature> = candidates
        .filter(|signature| usable(signature))
        .take(MAX_SIGNATURES)
        .collect();
    if covering.is_empty() {
        return None;
    }
    let keys = Keys::default();
    for signature in &covering {
        let name = key_name(signature);
        if let Txt::Records(records) = web.txt(&name).await {
            let records: Vec<Vec<u8>> = records.into_iter().map(String::into_bytes).collect();
            let key = TxtRecord::from(DomainKey::parse_records(&records));
            keys.txt.0.borrow_mut().insert(name.into_boxed_str(), key);
        }
    }
    // No servers: a name the core did not look up is an error, never a query of mail-auth's own.
    let nowhere = ResolverConfig::from_parts(None, Vec::new(), Vec::new());
    let authenticator = MessageAuthenticator::new(nowhere, ResolverOpts::default()).ok()?;
    let outputs = authenticator
        .verify_dkim(Parameters::new(&message).with_cache(&keys))
        .await;
    let passed = |output: &mail_auth::DkimOutput<'_>| {
        *output.result() == DkimResult::Pass && output.signature().is_some_and(usable)
    };
    outputs.iter().any(passed).then_some(url)
}

/// True when the signature's `h=` names From (RFC 6376 section 6.1 requires it) and both fields
/// RFC 8058 needs signed.
fn covers(signature: &Signature) -> bool {
    let names = |name: &str| signature.h.iter().any(|signed| signed.eq_ignore_ascii_case(name));
    names("From") && names("List-Unsubscribe") && names("List-Unsubscribe-Post")
}

/// True when the signing domain `d=` is the From domain, or one it sits under: relaxed
/// alignment, without a public suffix list. A `d=` of one label, such as `com`, never aligns.
fn aligned(signature: &Signature, from_domain: &str) -> bool {
    let signer = signature.d.trim_end_matches('.').to_ascii_lowercase();
    signer.contains('.') && (from_domain == signer || from_domain.ends_with(&format!(".{signer}")))
}

/// Where a signature's key record lives: `<selector>._domainkey.<domain>.`, lowercase, as
/// mail-auth looks it up.
fn key_name(signature: &Signature) -> String {
    format!("{}._domainkey.{}.", signature.s, signature.d).to_lowercase()
}

/// The key records the core looked up, as mail-auth's DNS cache. Only TXT is kept.
#[derive(Default)]
struct Keys {
    txt: Records,
}

/// Each name's parsed record.
#[derive(Default)]
struct Records(RefCell<HashMap<Box<str>, TxtRecord>>);

impl ResolverCache<Box<str>, TxtRecord> for Records {
    fn get<Q>(&self, name: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.0.borrow().get(name).cloned()
    }

    fn remove<Q>(&self, name: &Q) -> Option<TxtRecord>
    where
        Box<str>: std::borrow::Borrow<Q>,
        Q: Hash + Eq + ?Sized,
    {
        self.0.borrow_mut().remove(name)
    }

    /// mail-auth stores what it found; it finds nothing but errors, which stay out.
    fn insert(&self, _: Box<str>, _: TxtRecord, _: std::time::Instant) {}
}

impl DnsCache for Keys {
    type Txt = Records;
    type Mx = NoCache;
    type Ipv4 = NoCache;
    type Ipv6 = NoCache;
    type Ptr = NoCache;

    fn txt(&self) -> Option<&Records> {
        Some(&self.txt)
    }

    fn mx(&self) -> Option<&NoCache> {
        None
    }

    fn ipv4(&self) -> Option<&NoCache> {
        None
    }

    fn ipv6(&self) -> Option<&NoCache> {
        None
    }

    fn ptr(&self) -> Option<&NoCache> {
        None
    }
}
