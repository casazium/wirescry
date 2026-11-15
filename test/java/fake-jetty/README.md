# Stand-in Jetty classes

Not Jetty's code: classes with Jetty 9.4's names and shapes, written here, so test/java-agent-jetty.test.ts can make Wirescry's Jetty hooks fail on purpose. `JettyLoaderProbe fake DIR` loads one set in a class loader of its own, and `describe N HOST` makes an Origin for HOST as Jetty does for a request and asks the configuration for its proxy.

- `ok/`: the shapes the hooks need, so a request is tagged for Wirescry and given its proxy. The baseline the others differ from.
- `no-match/`: a `ProxyConfiguration` without `match(Origin)`, so its weave fails. The Origin hook must then leave every request untagged (a tag with no proxy hook would make a destination that's tagged but direct, kept for the client's life), and the status file must say `jetty:failed`.
- `no-ctor/`: an `Origin` without the constructor the hook copies it with, so the hook can't tag: requests stay as they are, and the status file must say `jetty:failed`.
- `no-address/`: an `Origin` without `getAddress`, so the hook fails as it reads a request: requests stay as they are, and the status file must say `jetty:failed`.
- `no-proxy/`: an `HttpProxy` without the `(String, int)` constructor, so Wirescry's proxy can't be made: the hook must tag nothing (a tagged request would go direct, for good), and the status file must say `jetty:failed`.
- `shaded/`: a renamed ("shaded") copy under `com.example.shaded.`: the hooks don't know the names, so they must leave it alone, and the status file must say nothing of Jetty.
