//! Counts the view work the core does. budget.rs holds each commit to a budget of this
//! work that does not grow with the mailbox. A count is the same on every machine, unlike
//! wall time, so the budget cannot flake on a slow one.

use std::cell::Cell;
use std::ops::Sub;

/// The view work done so far. Read it before and after a step to get the step's work.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Work {
    /// Threads whose row was built from their messages.
    pub summarized: u64,
    /// Threads checked against a thread list's filter.
    pub matched: u64,
    /// People a recipients view folded and ranked (see suggestions.rs).
    pub ranked: u64,
}

impl Sub for Work {
    type Output = Work;
    fn sub(self, earlier: Work) -> Work {
        Work {
            summarized: self.summarized - earlier.summarized,
            matched: self.matched - earlier.matched,
            ranked: self.ranked - earlier.ranked,
        }
    }
}

/// Where the views count their work as they do it.
#[derive(Default)]
pub struct Meter {
    work: Cell<Work>,
}

impl Meter {
    pub fn summarized(&self) {
        let work = self.work.get();
        self.work.set(Work {
            summarized: work.summarized + 1,
            ..work
        });
    }

    pub fn matched(&self) {
        let work = self.work.get();
        self.work.set(Work {
            matched: work.matched + 1,
            ..work
        });
    }

    pub fn ranked(&self) {
        let work = self.work.get();
        self.work.set(Work {
            ranked: work.ranked + 1,
            ..work
        });
    }

    #[cfg(test)]
    pub fn read(&self) -> Work {
        self.work.get()
    }
}
