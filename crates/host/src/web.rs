//! The `Web` both programs give the core (crates/core/src/web.rs): one https GET of an image,
//! or one https POST of a one-click unsubscribe, per call, over reqwest with rustls. It follows
//! no redirect, sends no referrer, keeps no cookies (the client has no cookie store), sends no
//! credentials, uses no proxy, and stops reading a body at the limit. It looks up the TXT
//! records of a DKIM key through the system's DNS servers (hickory), and core-sim's through the
//! fake web's `/.txt/<name>`.
//!
//! It connects only to public addresses (`public`). A host that is an IP literal is checked
//! as it is. A name is resolved by the client's own resolver (`PublicOnly`), which refuses the
//! whole name when any address it resolves to is not public, and the client connects only to
//! the addresses that resolver returned, so a name cannot resolve one way for the check and
//! another for the connection. TLS still checks the certificate against the name.
//!
//! core-sim runs it against the harness's fake web instead (`Route`): every request goes to the
//! fake over plain http, and the fake answers the name lookups too, so a scenario can point a
//! name at a private address. Only the resolver and the address connected to differ: the check
//! on every address is the same code.

use std::error::Error;
use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hickory_resolver::TokioResolver;
use hickory_resolver::proto::rr::RData;
use letterbox_core::adapter::LocalFuture;
use letterbox_core::web::{Fetched, Web};
use letterbox_core::web::{Posted, Txt};
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{CONTENT_TYPE, LOCATION};
use reqwest::redirect::Policy;
use url::{Host, Url};

/// How long one image request may take, start to end.
const TIMEOUT: Duration = Duration::from_secs(20);

/// True when `ip` is an address on the public internet. False for unspecified, loopback,
/// private, shared (CGNAT), link-local (169.254.169.254 among them), multicast, broadcast,
/// documentation, benchmarking and other reserved ranges, IPv6 unique-local and site-local,
/// and for an IPv4 address in any IPv6 form (mapped, compatible, NAT64, 6to4) that is one of these.
pub fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => public_v6(ip),
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let reserved = a == 0                        // "this network" and 0.0.0.0
        || a == 10                               // private
        || a == 100 && (64..128).contains(&b)    // shared address space (CGNAT)
        || a == 127                              // loopback
        || a == 169 && b == 254                  // link-local, cloud metadata
        || a == 172 && (16..32).contains(&b)     // private
        || a == 192 && b == 0 && c == 0          // IETF protocol assignments
        || a == 192 && b == 0 && c == 2          // documentation (TEST-NET-1)
        || a == 192 && b == 88 && c == 99        // 6to4 relay anycast
        || a == 192 && b == 168                  // private
        || a == 198 && (18..20).contains(&b)     // benchmarking
        || a == 198 && b == 51 && c == 100       // documentation (TEST-NET-2)
        || a == 203 && b == 0 && c == 113        // documentation (TEST-NET-3)
        || a >= 224; // multicast, reserved and broadcast
    !reserved
}

/// IPv6, by the IANA IPv6 Special-Purpose Address Registry. Only global unicast (2000::/3) can
/// be public, less the registry's ranges that are not globally reachable. Outside it, every
/// range is special or unassigned: loopback, unspecified, IPv4-compatible (::/96), the
/// local-use NAT64 prefix 64:ff9b:1::/48 (RFC 8215), discard-only 100::/64, the dummy prefix
/// 100:0:0:1::/64, segment routing 5f00::/16, unique-local, link-local, site-local, multicast.
/// The forms that carry an IPv4 address are as public as it: mapped (::ffff:0:0/96), the
/// well-known NAT64 prefix (64:ff9b::/96) and 6to4 (2002::/16).
fn public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    let embedded = |high: u16, low: u16| Ipv4Addr::new((high >> 8) as u8, high as u8, (low >> 8) as u8, low as u8);
    if segments[..6] == [0, 0, 0, 0, 0, 0xffff] {
        return public_v4(embedded(segments[6], segments[7]));
    }
    if segments[..6] == [0x0064, 0xff9b, 0, 0, 0, 0] {
        return public_v4(embedded(segments[6], segments[7]));
    }
    if segments[0] == 0x2002 {
        return public_v4(embedded(segments[1], segments[2]));
    }
    if segments[0] & 0xe000 != 0x2000 {
        return false;
    }
    match (segments[0], segments[1]) {
        // 2001::/23, IETF protocol assignments, is not global but for the parts the registry
        // marks so: the anycast 2001:1::1 to 2001:1::3, AMT 2001:3::/32, AS112 2001:4:112::/48,
        // ORCHIDv2 2001:20::/28 and drone remote ID 2001:30::/28. Teredo (2001::/32),
        // benchmarking (2001:2::/48) and the old ORCHID (2001:10::/28) are not.
        (0x2001, 0x0001) => segments[2..7] == [0; 5] && (1..=3).contains(&segments[7]),
        (0x2001, 0x0003) | (0x2001, 0x0020..=0x003f) => true,
        (0x2001, 0x0004) => segments[2] == 0x0112,
        (0x2001, second) if second < 0x0200 => false,
        // Documentation: 2001:db8::/32 and 3fff::/20 (RFC 9637).
        (0x2001, 0x0db8) => false,
        (0x3fff, second) if second < 0x1000 => false,
        _ => true,
    }
}

/// The error `PublicOnly` answers with, so `HttpsWeb` can tell a refused name from a failed one.
#[derive(Debug)]
struct NotPublic;

impl fmt::Display for NotPublic {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the host resolves to an address that is not public")
    }
}

impl Error for NotPublic {}

/// The client's resolver: the system's, refusing a name when any address it resolves to is not
/// public. The client connects only to what it returns.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let found: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if found.is_empty() || found.iter().any(|address| !public(address.ip())) {
                return Err(Box::new(NotPublic) as Box<dyn Error + Send + Sync>);
            }
            let addresses: Addrs = Box::new(found.into_iter());
            Ok(addresses)
        })
    }
}

/// core-sim's stand-in for the web: the fake's base URL. The fake answers `/.dns/<name>` with
/// the addresses the name resolves to, one per line, `/.txt/<name>` with its TXT records, one
/// per line, and every other path as a request for `https://<path>`.
struct Route {
    base: String,
}

pub struct HttpsWeb {
    client: reqwest::Client,
    route: Option<Route>,
}

impl HttpsWeb {
    /// A person's: the system's resolver behind the public-address check. With `route`,
    /// core-sim's: every lookup and request goes to the fake web at that base URL.
    pub fn new(route: Option<String>) -> HttpsWeb {
        let builder = reqwest::Client::builder()
            .redirect(Policy::none())
            .referer(false)
            .no_proxy()
            .timeout(TIMEOUT);
        let builder = match &route {
            None => builder.dns_resolver(Arc::new(PublicOnly)),
            Some(_) => builder,
        };
        let client = builder.build().expect("a client with rustls and no redirects builds");
        HttpsWeb {
            client,
            route: route.map(|base| Route {
                base: base.trim_end_matches('/').to_owned(),
            }),
        }
    }

    /// The addresses core-sim's fake web says `name` resolves to.
    async fn fake_lookup(&self, route: &Route, name: &str) -> Option<Vec<IpAddr>> {
        let answer = self
            .client
            .get(format!("{}/.dns/{name}", route.base))
            .send()
            .await
            .ok()?;
        let text = answer.text().await.ok()?;
        text.lines().map(|line| line.trim().parse().ok()).collect()
    }

    /// Where a request for `url` goes: the URL itself, or core-sim's fake for it. Refuses a host
    /// whose address is not public before anything connects: an IP literal as written, and in
    /// core-sim a name by the fake's lookup. A person's names are checked by `PublicOnly`.
    async fn target(&self, url: &str) -> Result<String, Stop> {
        let parsed = Url::parse(url).map_err(|_| Stop::Failed)?;
        match (&self.route, parsed.host()) {
            (_, None) => Err(Stop::Failed),
            (_, Some(Host::Ipv4(ip))) if !public(IpAddr::V4(ip)) => Err(Stop::Refused),
            (_, Some(Host::Ipv6(ip))) if !public(IpAddr::V6(ip)) => Err(Stop::Refused),
            (None, Some(_)) => Ok(url.to_owned()),
            (Some(route), Some(host)) => {
                if let Host::Domain(name) = host {
                    match self.fake_lookup(route, name).await {
                        Some(found) if !found.is_empty() && found.iter().all(|ip| public(*ip)) => {}
                        Some(_) => return Err(Stop::Refused),
                        None => return Err(Stop::Failed),
                    }
                }
                let rest = url.strip_prefix("https://").ok_or(Stop::Failed)?;
                Ok(format!("{}/{rest}", route.base))
            }
        }
    }

    async fn fetch(&self, url: &str, limit: usize) -> Fetched {
        let target = match self.target(url).await {
            Ok(target) => target,
            Err(Stop::Refused) => return Fetched::Refused,
            Err(Stop::Failed) => return Fetched::Failed,
        };
        let mut response = match self.client.get(target).send().await {
            Ok(response) => response,
            Err(error) if refused(&error) => return Fetched::Refused,
            Err(_) => return Fetched::Failed,
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

impl HttpsWeb {
    /// One POST of `List-Unsubscribe=One-Click`, form-encoded (RFC 8058 section 3.2). Only the
    /// status is read. A request that never connected is `NotSent`, one that may have gone out
    /// and got no whole answer `NoAnswer`. A URL with a user name or password is not sent at
    /// all: reqwest would send them as an Authorization header, which RFC 8058 forbids. The
    /// core refuses one before it gets here (dkim.rs); this keeps the rule where the request goes.
    async fn post(&self, url: &str) -> Posted {
        let userinfo = Url::parse(url).map(|url| !url.username().is_empty() || url.password().is_some());
        if userinfo.unwrap_or(true) {
            return Posted::NotSent;
        }
        let target = match self.target(url).await {
            Ok(target) => target,
            Err(Stop::Refused) => return Posted::Refused,
            Err(Stop::Failed) => return Posted::NotSent,
        };
        let request = self
            .client
            .post(target)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body("List-Unsubscribe=One-Click");
        match request.send().await {
            Ok(response) if response.status().is_redirection() => Posted::Redirect,
            Ok(response) => Posted::Answered {
                status: response.status().as_u16(),
            },
            Err(error) if refused(&error) => Posted::Refused,
            Err(error) if error.is_connect() || error.is_builder() => Posted::NotSent,
            Err(_) => Posted::NoAnswer,
        }
    }

    /// The TXT records of `name`, through the system's DNS servers, or core-sim's fake.
    async fn lookup_txt(&self, name: &str) -> Txt {
        if let Some(route) = &self.route {
            let found = self.client.get(format!("{}/.txt/{name}", route.base)).send().await;
            let Ok(found) = found else { return Txt::Failed };
            let Ok(text) = found.text().await else {
                return Txt::Failed;
            };
            let records: Vec<String> = text
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect();
            return if records.is_empty() {
                Txt::None
            } else {
                Txt::Records(records)
            };
        }
        let Ok(resolver) = TokioResolver::builder_tokio().and_then(|builder| builder.build()) else {
            return Txt::Failed;
        };
        match resolver.txt_lookup(name).await {
            Ok(lookup) => Txt::Records(
                lookup
                    .answers()
                    .iter()
                    .filter_map(|record| match &record.data {
                        RData::TXT(txt) => {
                            Some(txt.txt_data.iter().map(|part| String::from_utf8_lossy(part)).collect())
                        }
                        _ => None,
                    })
                    .collect(),
            ),
            Err(error) if error.is_no_records_found() || error.is_nx_domain() => Txt::None,
            Err(_) => Txt::Failed,
        }
    }
}

/// Why a request does not go out (`HttpsWeb::target`).
enum Stop {
    /// The host's address is not public.
    Refused,
    /// The URL has no host, or core-sim's fake could not be asked.
    Failed,
}

/// True when a request failed because `PublicOnly` refused its host.
fn refused(error: &reqwest::Error) -> bool {
    let mut source: Option<&(dyn Error + 'static)> = error.source();
    while let Some(cause) = source {
        if cause.is::<NotPublic>() {
            return true;
        }
        source = cause.source();
    }
    false
}

impl Web for HttpsWeb {
    fn get(&self, url: &str, limit: usize) -> LocalFuture<'_, Fetched> {
        let url = url.to_owned();
        Box::pin(async move { self.fetch(&url, limit).await })
    }

    fn post_one_click(&self, url: &str) -> LocalFuture<'_, Posted> {
        let url = url.to_owned();
        Box::pin(async move { self.post(&url).await })
    }

    fn txt(&self, name: &str) -> LocalFuture<'_, Txt> {
        let name = name.to_owned();
        Box::pin(async move { self.lookup_txt(&name).await })
    }
}
