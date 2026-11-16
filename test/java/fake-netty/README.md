# Stand-in Reactor Netty classes

Not Reactor Netty's code: classes with its names and shapes, written here, so test/java-agent-netty.test.ts can make Wirescry's Reactor Netty hook fail on purpose. `NettyLoaderProbe fake DIR` loads one set in a class loader of its own, and `describe N` calls `HttpConnectionProvider.acquire` with a config for `proxied.test`, as Reactor Netty does for a request, and says whether the hook changed the config it was handed.

- `no-copy/`: an `HttpClientConfig` without the copy constructor the hook makes Wirescry's config with, so the hook can't read the library: requests stay as they are, and the status file must say `reactor-netty:failed`.
- A renamed ("shaded") copy of `no-copy/`, under `shaded.`, which the test makes from it: the hook doesn't know the names, so it must leave it alone, and the status file must say nothing of Reactor Netty.
