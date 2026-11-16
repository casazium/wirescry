import io.netty.handler.ssl.SslContext;
import io.netty.handler.ssl.SslContextBuilder;
import io.netty.handler.ssl.util.InsecureTrustManagerFactory;
import io.netty.resolver.AddressResolver;
import io.netty.resolver.AddressResolverGroup;
import io.netty.resolver.InetSocketAddressResolver;
import io.netty.resolver.NoopAddressResolverGroup;
import io.netty.util.concurrent.EventExecutor;
import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.net.UnknownHostException;
import java.security.KeyStore;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import javax.net.ssl.TrustManagerFactory;
import reactor.core.publisher.Mono;
import reactor.netty.Connection;
import reactor.netty.ConnectionObserver;
import reactor.netty.http.HttpProtocol;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.ConnectionProvider;
import reactor.netty.resources.LoopResources;
import reactor.netty.transport.ClientTransportConfig;
import reactor.netty.transport.ProxyProvider;
import reactor.netty.transport.TransportConfig;

/**
 * A program using Reactor Netty's HttpClient (1.0 to 1.3), driven one command per line on stdin,
 * one answer per line on stdout (see test/java-agent-netty.test.ts). Built against each release's
 * jars, so it uses only what every release has, and reaches the rest by reflection.
 *
 * <ul>
 *   <li>`route KIND URL`: what HttpConnectionProvider.acquire was handed for a request with that
 *       kind of client (made once per kind, and kept): `PROXY host:port RESOLVER` or `DIRECT RESOLVER`, the resolver `noop`, `own`
 *       (the program's) or `dns`. Read through a ConnectionProvider of the probe's, which is handed
 *       the config acquire was given; the request then fails on purpose.
 *   <li>`get KIND URL`: the request, `OK body` or `FAIL exception: message`. Each kind's client is
 *       made once and kept, with its connection pool.
 *   <li>`fresh URL`: the same with a client made now.
 *   <li>`set NAME [VALUE]`: a system property (cleared without a value).
 *   <li>`lookups`: how many lookups the `resolver` kind's own resolver made.
 *   <li>`openssl`: whether Netty's OpenSSL engine is there.
 *   <li>`bench N URL`: nanoseconds per `route` of the default kind, best of the run.
 *   <li>`hook KIND SCHEME HOST PORT`: what the agent's decision answers, called directly (see
 *       hook): every protocol, HTTP/2 and HTTP/3 included, and odd addresses.
 *   <li>`wsroute KIND URL`: as `route`, for a WebSocket.
 *   <li>`storm THREADS MS URL`: `hook` from many threads at once: the distinct answers.
 *   <li>`webclient URL`: the request through Spring's WebClient (NettyWebClient), if it's there.
 * </ul>
 *
 * Kinds: `default`; `h2` (H2 and HTTP/1.1), `h2only`, `h2c`, `h11h2c` and `h3` (HTTP/3, where the
 * release has it); `own:PORT` (the program's proxy at 127.0.0.1:PORT) and `ownskip:PORT` (the same,
 * excluding 127.0.0.1); `sysprops` (proxyWithSystemProperties, made when first used); `resolver`
 * (an AddressResolverGroup of its own, sending every host to 127.0.0.1) and `nameres` (a
 * customized DNS resolver); `runon` (its own event loops, which fills in the default resolver);
 * `hostsfile` (a hosts-file resolver of its own, 1.0.48 on); `ownhost:HOST:PORT` (the program's
 * proxy by name); `socks:PORT` (a SOCKS proxy of its own); `nopool` (no connection pool);
 * `sysrunon` and `sysresolver` (the same, with its own event loops, or its own resolver);
 * `address` (a remote address that's not a host and port); `insecure` (trusts any certificate);
 * `trust:PASS:FILE` (trusts only that PKCS12 store); `pinned` (a pinned certificate, by Netty's own
 * trust manager); `opensslclient` (Netty's OpenSSL engine).
 */
public final class NettyProbe {
  /** The `resolver` kind's own resolver: every host is 127.0.0.1. */
  static final AtomicInteger lookups = new AtomicInteger();

  static final AddressResolverGroup<InetSocketAddress> OWN =
      new AddressResolverGroup<InetSocketAddress>() {
        @Override
        protected AddressResolver<InetSocketAddress> newResolver(EventExecutor executor) {
          return new InetSocketAddressResolver(executor, new io.netty.resolver.DefaultNameResolver(executor) {
            @Override
            protected void doResolve(String host, io.netty.util.concurrent.Promise<InetAddress> promise) {
              lookups.incrementAndGet();
              try {
                promise.setSuccess(InetAddress.getByAddress(host, new byte[] {127, 0, 0, 1}));
              } catch (UnknownHostException e) {
                promise.setFailure(e);
              }
            }

            @Override
            protected void doResolveAll(String host, io.netty.util.concurrent.Promise<List<InetAddress>> promise) {
              lookups.incrementAndGet();
              try {
                promise.setSuccess(Collections.singletonList(InetAddress.getByAddress(host, new byte[] {127, 0, 0, 1})));
              } catch (UnknownHostException e) {
                promise.setFailure(e);
              }
            }
          });
        }
      };

  /** Records what acquire was handed, then fails the request. */
  static final class Recorder implements ConnectionProvider {
    volatile String last = "NOTHING";

    @Override
    public Mono<? extends Connection> acquire(
        TransportConfig config,
        ConnectionObserver observer,
        Supplier<? extends SocketAddress> remote,
        AddressResolverGroup<?> resolver) {
      ProxyProvider p = ((ClientTransportConfig<?>) config).proxyProvider();
      String r = resolver instanceof NoopAddressResolverGroup ? "noop" : resolver == OWN ? "own" : "dns";
      String where = "DIRECT";
      if (p != null) {
        InetSocketAddress a = p.getAddress().get();
        where = "PROXY " + a.getHostString() + ":" + a.getPort();
      }
      last = where + " " + r;
      return Mono.error(new IllegalStateException("recorded"));
    }
  }

  static final Map<String, HttpClient> clients = new HashMap<String, HttpClient>();
  /** `route`'s clients, one per kind, each with its Recorder: made once, as `get`'s are. */
  static final Map<String, Object[]> routed = new HashMap<String, Object[]>();

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(System.out, true, "UTF-8");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    out.println("ready");
    for (String line; (line = in.readLine()) != null; ) {
      String answer;
      try {
        answer = command(line.trim().split(" "));
      } catch (Throwable t) {
        answer = "FAIL " + describe(t);
      }
      out.println(answer.replace('\n', ' '));
    }
  }

  static String command(String[] p) throws Exception {
    switch (p[0]) {
      case "route":
        return route(p[1], p[2]);
      case "get":
        {
          HttpClient c = clients.get(p[1]);
          if (c == null) clients.put(p[1], c = client(p[1], null));
          return get(c, p[2]);
        }
      case "fresh":
        return get(client("default", null), p[1]);
      case "hook":
        return hook(p[1], p[2], p[3], Integer.parseInt(p[4]));
      case "wsroute":
        return wsroute(p[1], p[2]);
      case "set":
        if (p.length > 2) System.setProperty(p[1], p[2]);
        else System.clearProperty(p[1]);
        return "set";
      case "lookups":
        return String.valueOf(lookups.get());
      case "openssl":
        return String.valueOf(io.netty.handler.ssl.OpenSsl.isAvailable());
      case "bench":
        {
          int n = Integer.parseInt(p[1]);
          Recorder rec = new Recorder();
          HttpClient c = client("default", rec);
          long best = Long.MAX_VALUE;
          for (int round = 0; round < 5; round++) {
            long start = System.nanoTime();
            for (int i = 0; i < n; i++) attempt(c, p[2]);
            best = Math.min(best, (System.nanoTime() - start) / n);
          }
          return "NS " + best + " " + rec.last;
        }
      case "storm":
        {
          final int threads = Integer.parseInt(p[1]);
          final long until = System.currentTimeMillis() + Long.parseLong(p[2]);
          final String url = p[3];
          final java.util.Set<String> answers = Collections.synchronizedSet(new TreeSet<String>());
          final AtomicInteger errors = new AtomicInteger();
          List<Thread> all = new ArrayList<Thread>();
          for (int t = 0; t < threads; t++) {
            Thread thread =
                new Thread() {
                  @Override
                  public void run() {
                    // At least once each, so threads that start after the deadline still answer.
                    do {
                      try {
                        java.net.URI u = java.net.URI.create(url);
                        answers.add(hook("default", u.getScheme(), u.getHost(), u.getPort() < 0 ? 80 : u.getPort()));
                      } catch (Throwable e) {
                        errors.incrementAndGet();
                      }
                    } while (System.currentTimeMillis() < until);
                  }
                };
            thread.start();
            all.add(thread);
          }
          for (Thread t : all) t.join();
          StringBuilder b = new StringBuilder();
          for (String a : answers) b.append(b.length() == 0 ? "" : "|").append(a);
          return "ANSWERS " + b + " ERRORS " + errors.get();
        }
      case "webclient":
        return "OK " + Class.forName("NettyWebClient").getMethod("get", String.class).invoke(null, p[1]);
      default:
        return "unknown command";
    }
  }

  public static synchronized String route(String kind, String url) throws Exception {
    Object[] known = routed.get(kind);
    if (known == null) {
      Recorder rec = new Recorder();
      routed.put(kind, known = new Object[] {client(kind, rec), rec});
    }
    Recorder rec = (Recorder) known[1];
    rec.last = "NOTHING";
    attempt((HttpClient) known[0], url);
    return rec.last;
  }

  /**
   * What HttpConnectionProvider.acquire hands on for `host` and `port`, called directly as Reactor
   * Netty calls it, with the default client's config: no request, so none of Reactor Netty's
   * threads start (for NettyLoaderProbe, whose class loaders must be free to go).
   */
  public static String decide(String host, int port) throws Exception {
    Recorder rec = new Recorder();
    HttpClient c = HttpClient.create(rec);
    // Reactor Netty's own HttpConnectionProvider around the Recorder (connectionProvider() is the
    // Recorder itself): package-private, so by reflection.
    java.lang.reflect.Method wrapper = c.configuration().getClass().getDeclaredMethod("httpConnectionProvider");
    wrapper.setAccessible(true);
    ConnectionProvider provider = (ConnectionProvider) wrapper.invoke(c.configuration());
    provider.acquire(
        c.configuration(),
        ConnectionObserver.emptyListener(),
        () -> InetSocketAddress.createUnresolved(host, port),
        io.netty.resolver.DefaultAddressResolverGroup.INSTANCE);
    return rec.last;
  }

  /**
   * What the agent's decision (com.wirescry.agent.impl.ReactorNetty.acquire, on the system class
   * path with the agent) answers for a request to HOST:PORT with a client of `kind`, its config as
   * Reactor Netty hands it to acquire (`https`: with TLS). `LEAVE` (no change, or no agent), or
   * `PROXY host:port RESOLVER` for the config it gives, the resolver `noop`, `same` (the one handed
   * in) or `other`. No request, and no lock: many threads may ask at once.
   */
  public static String hook(String kind, String scheme, final String host, final int port) throws Exception {
    HttpClient c = client(kind, new Recorder());
    if ("https".equals(scheme)) c = c.secure();
    Object config = c.configuration();
    Supplier<SocketAddress> remote =
        "address".equals(kind)
            ? () -> new SocketAddress() {}
            : () -> InetSocketAddress.createUnresolved(host, port);
    Object resolver = io.netty.resolver.DefaultAddressResolverGroup.INSTANCE;
    Class<?> agent;
    try {
      agent = Class.forName("com.wirescry.agent.impl.ReactorNetty", false, ClassLoader.getSystemClassLoader());
    } catch (ClassNotFoundException e) {
      return "LEAVE";
    }
    Object[] got =
        (Object[]) agent.getMethod("acquire", Object.class, Object.class, Object.class).invoke(null, config, remote, resolver);
    if (got == null) return "LEAVE";
    ProxyProvider p = ((ClientTransportConfig<?>) got[0]).proxyProvider();
    String r = got[1] instanceof NoopAddressResolverGroup ? "noop" : got[1] == resolver ? "same" : "other";
    if (p == null) return "DIRECT " + r;
    InetSocketAddress a = p.getAddress().get();
    return "PROXY " + a.getHostString() + ":" + a.getPort() + " " + r;
  }

  /** What acquire was handed for a WebSocket to URL with a client of `kind` (as `route`). */
  static String wsroute(String kind, String url) throws Exception {
    Recorder rec = new Recorder();
    HttpClient c = client(kind, rec);
    try {
      c.websocket().uri(url).handle((in, out) -> out.neverComplete()).blockLast(Duration.ofSeconds(20));
    } catch (Throwable expected) {
      // "recorded"
    }
    return rec.last;
  }

  /** One request that the Recorder fails: what it was handed is in the Recorder. */
  static void attempt(HttpClient c, String url) {
    try {
      c.get().uri(url).responseContent().aggregate().asString().block(Duration.ofSeconds(20));
    } catch (Throwable expected) {
      // "recorded", or a request refused before acquire.
    }
  }

  static String get(HttpClient c, String url) {
    try {
      String body = c.followRedirect(true).get().uri(url).responseContent().aggregate().asString().block(Duration.ofSeconds(20));
      return "OK " + body;
    } catch (Throwable t) {
      return "FAIL " + describe(t);
    }
  }

  /** The first UnknownHostException or SSLHandshakeException in the causes, else the deepest. */
  static String describe(Throwable t) {
    Throwable deepest = t;
    for (Throwable c = t; c != null; c = c.getCause()) {
      if (c instanceof UnknownHostException || c instanceof javax.net.ssl.SSLHandshakeException) {
        deepest = c;
        break;
      }
      deepest = c;
      if (c.getCause() == c) break;
    }
    return deepest.getClass().getName() + ": " + deepest.getMessage();
  }

  static HttpClient client(String kind, ConnectionProvider provider) throws Exception {
    HttpClient c = provider == null ? HttpClient.create() : HttpClient.create(provider);
    // At most three parts: the last may be a path, and a Windows path has a colon (C:\...).
    String[] k = kind.split(":", 3);
    switch (k[0]) {
      case "default":
        return c;
      case "h2":
        return c.protocol(HttpProtocol.H2, HttpProtocol.HTTP11);
      case "h2only":
        return c.protocol(HttpProtocol.H2);
      case "h2c":
        return c.protocol(HttpProtocol.H2C);
      case "h11h2c":
        return c.protocol(HttpProtocol.HTTP11, HttpProtocol.H2C);
      case "h3":
        return c.protocol(HttpProtocol.valueOf("HTTP3"));
      case "own":
      case "ownskip":
        {
          final int port = Integer.parseInt(k[1]);
          final boolean skip = "ownskip".equals(k[0]);
          return c.proxy(
              spec -> {
                ProxyProvider.Builder b = spec.type(ProxyProvider.Proxy.HTTP).host("127.0.0.1").port(port);
                // An address, not a name: Reactor Netty looks an excluded name up on the caller's
                // thread, which a runner's DNS can hold for longer than a test waits.
                if (skip) b.nonProxyHosts("127\\.0\\.0\\.1");
              });
        }
      case "sysprops":
        // Not in 1.0.0: by name, so the probe builds against it.
        return (HttpClient) HttpClient.class.getMethod("proxyWithSystemProperties").invoke(c);
      case "sysrunon":
        return (HttpClient)
            HttpClient.class
                .getMethod("proxyWithSystemProperties")
                .invoke(c.runOn(LoopResources.create("probe-sys", 1, true), false));
      case "hostsfile":
        {
          // A hosts-file resolver of the program's own (from 1.0.48): proxied.test is 127.0.0.1.
          final io.netty.resolver.HostsFileEntriesResolver hosts =
              (name, types) -> "proxied.test".equals(name) ? InetAddress.getLoopbackAddress() : null;
          return c.resolver(
              spec -> {
                try {
                  // By the public interface (the builder's class isn't public); not in 1.0.0.
                  reactor.netty.transport.NameResolverProvider.NameResolverSpec.class
                      .getMethod("hostsFileEntriesResolver", io.netty.resolver.HostsFileEntriesResolver.class)
                      .invoke(spec, hosts);
                } catch (ReflectiveOperationException e) {
                  throw new IllegalStateException(e);
                }
              });
        }
      case "ownhost":
        {
          // The program's proxy, named rather than 127.0.0.1: ownhost:HOST:PORT.
          final String h = k[1];
          final int port = Integer.parseInt(k[2]);
          return c.proxy(spec -> spec.type(ProxyProvider.Proxy.HTTP).host(h).port(port));
        }
      case "socks":
        {
          final int port = Integer.parseInt(k[1]);
          return c.proxy(spec -> spec.type(ProxyProvider.Proxy.SOCKS5).host("127.0.0.1").port(port));
        }
      case "nopool":
        return provider == null ? HttpClient.newConnection() : c;
      case "sysresolver":
        return (HttpClient) HttpClient.class.getMethod("proxyWithSystemProperties").invoke(c.resolver(OWN));
      case "resolver":
        return c.resolver(OWN);
      case "nameres":
        return c.resolver(spec -> spec.ndots(2));
      case "runon":
        return c.runOn(LoopResources.create("probe-" + kind.hashCode(), 1, true), false);
      case "address":
        return c.remoteAddress(() -> new SocketAddress() {});
      case "insecure":
        {
          final SslContext ctx = SslContextBuilder.forClient().trustManager(InsecureTrustManagerFactory.INSTANCE).build();
          return c.secure(spec -> spec.sslContext(ctx));
        }
      case "trust":
        {
          KeyStore store = KeyStore.getInstance("PKCS12");
          // trust:PASS:FILE
          try (FileInputStream in = new FileInputStream(k[2])) {
            store.load(in, k[1].toCharArray());
          }
          TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
          tmf.init(store);
          final SslContext ctx = SslContextBuilder.forClient().trustManager(tmf).build();
          return c.secure(spec -> spec.sslContext(ctx));
        }
      case "pinned":
        {
          // Pinned to one certificate (SHA-1 of a made-up one): a trust manager of the program's own.
          @SuppressWarnings("deprecation")
          final SslContext ctx =
              SslContextBuilder.forClient()
                  .trustManager(new io.netty.handler.ssl.util.FingerprintTrustManagerFactory("00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33"))
                  .build();
          return c.secure(spec -> spec.sslContext(ctx));
        }
      case "opensslclient":
        {
          final SslContext ctx = SslContextBuilder.forClient().sslProvider(io.netty.handler.ssl.SslProvider.OPENSSL).build();
          return c.secure(spec -> spec.sslContext(ctx));
        }
      default:
        throw new IllegalArgumentException("unknown kind " + kind);
    }
  }
}
