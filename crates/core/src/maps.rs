//! The maps and sets the core uses. They hash with foldhash rather than the standard
//! library's SipHash, which costs several times more per lookup. Lookups by id are most
//! of the work of answering a view. The seed is random per process, so someone who
//! picks a Message-ID cannot work out colliding keys ahead of time.

pub type Hasher = foldhash::fast::RandomState;
pub type HashMap<K, V> = std::collections::HashMap<K, V, Hasher>;
pub type HashSet<T> = std::collections::HashSet<T, Hasher>;
pub type IndexMap<K, V> = indexmap::IndexMap<K, V, Hasher>;
pub type IndexSet<T> = indexmap::IndexSet<T, Hasher>;
