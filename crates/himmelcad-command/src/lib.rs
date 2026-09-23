//! Dependency-free registration and dispatch for HimmelCAD RPC hosts.
//!
//! Wire requests, responses, and application context stay owned by the host.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

/// An owned asynchronous RPC handler result.
pub type RpcFuture<Response> = Pin<Box<dyn Future<Output = Response> + Send + 'static>>;

type Handler<Context, Request, Response> =
    dyn Fn(Request, Context) -> RpcFuture<Response> + Send + Sync + 'static;

/// Exact-method registry parameterized by host-owned wire and context types.
pub struct CommandRegistry<Context, Request, Response> {
    handlers: BTreeMap<&'static str, Box<Handler<Context, Request, Response>>>,
}

impl<Context, Request, Response> Default for CommandRegistry<Context, Request, Response> {
    fn default() -> Self {
        Self {
            handlers: BTreeMap::new(),
        }
    }
}

impl<Context, Request, Response> CommandRegistry<Context, Request, Response> {
    /// Registers one exact protocol method.
    ///
    /// Duplicate method ownership is rejected while the host is being built.
    pub fn register<RegisteredHandler>(
        &mut self,
        method: &'static str,
        handler: RegisteredHandler,
    ) -> Result<(), DuplicateMethod>
    where
        RegisteredHandler: Fn(Request, Context) -> RpcFuture<Response> + Send + Sync + 'static,
    {
        if self.handlers.contains_key(method) {
            return Err(DuplicateMethod { method });
        }
        self.handlers.insert(method, Box::new(handler));
        Ok(())
    }

    /// Returns registered exact methods in deterministic lexical order.
    pub fn methods(&self) -> impl ExactSizeIterator<Item = &'static str> + '_ {
        self.handlers.keys().copied()
    }

    /// Dispatches one request, returning the untouched request when unknown.
    ///
    /// The host owns unknown-method error construction so the registry never
    /// defines or changes wire response types.
    pub fn dispatch(
        &self,
        method: &str,
        request: Request,
        context: Context,
    ) -> Result<RpcFuture<Response>, (Request, Context)> {
        let Some(handler) = self.handlers.get(method) else {
            return Err((request, context));
        };
        Ok(handler(request, context))
    }
}

/// A module that contributes exact handlers to a command registry.
pub trait RpcModule<Context, Request, Response> {
    /// Registers all methods owned by this module.
    fn register(
        &self,
        registry: &mut CommandRegistry<Context, Request, Response>,
    ) -> Result<(), DuplicateMethod>;
}

/// Duplicate exact-method registration detected during host construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DuplicateMethod {
    method: &'static str,
}

impl DuplicateMethod {
    /// Returns the method that was registered more than once.
    #[must_use]
    pub const fn method(self) -> &'static str {
        self.method
    }
}

impl fmt::Display for DuplicateMethod {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "duplicate RPC method registration: {}",
            self.method
        )
    }
}

impl Error for DuplicateMethod {}

#[cfg(test)]
mod tests {
    use super::{CommandRegistry, RpcFuture};

    type Registry = CommandRegistry<(), u32, u32>;

    fn handler(request: u32, (): ()) -> RpcFuture<u32> {
        Box::pin(async move { request + 1 })
    }

    #[test]
    fn duplicate_registration_is_rejected() {
        let mut registry = Registry::default();
        registry.register("ping", handler).unwrap();
        let error = registry.register("ping", handler).unwrap_err();
        assert_eq!(error.method(), "ping");
        assert_eq!(error.to_string(), "duplicate RPC method registration: ping");
    }

    #[test]
    fn methods_are_exact_and_lexically_ordered() {
        let mut registry = Registry::default();
        registry.register("z.last", handler).unwrap();
        registry.register("a.first", handler).unwrap();
        assert_eq!(
            registry.methods().collect::<Vec<_>>(),
            ["a.first", "z.last"]
        );
        assert!(registry.dispatch("a.first", 1, ()).is_ok());
        assert!(registry.dispatch("a", 1, ()).is_err());
    }
}
