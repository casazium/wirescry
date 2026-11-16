package reactor.netty.http.client;

import io.netty.resolver.AddressResolverGroup;
import java.net.InetSocketAddress;
import java.net.SocketAddress;
import java.util.function.Supplier;
import reactor.netty.ConnectionObserver;
import reactor.netty.transport.TransportConfig;

/**
 * Stand-in: see test/java/fake-netty/README.md. Its acquire answers the config it was handed, so
 * describe can tell whether the hook changed it.
 */
public final class HttpConnectionProvider {
  public Object acquire(
      TransportConfig config,
      ConnectionObserver observer,
      Supplier<? extends SocketAddress> remote,
      AddressResolverGroup<?> resolver) {
    return config;
  }

  /** A request for proxied.test, as Reactor Netty makes one: "changed" or "unchanged". */
  public static String describe() {
    HttpClientConfig config = new HttpClientConfig();
    Supplier<SocketAddress> remote = () -> InetSocketAddress.createUnresolved("proxied.test", 80);
    Object got = new HttpConnectionProvider().acquire(config, null, remote, null);
    return got == config ? "unchanged" : "changed";
  }
}
