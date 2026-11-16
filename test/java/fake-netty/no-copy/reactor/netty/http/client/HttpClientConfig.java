package reactor.netty.http.client;

import reactor.netty.http.HttpProtocol;
import reactor.netty.transport.ClientTransportConfig;

/**
 * Stand-in: see test/java/fake-netty/README.md. Reactor Netty's has a copy constructor, which the
 * hook makes Wirescry's config with; this one doesn't.
 */
public final class HttpClientConfig extends ClientTransportConfig {
  public HttpProtocol[] protocols() {
    return new HttpProtocol[] {HttpProtocol.HTTP11};
  }

  public Object sslProvider() {
    return null;
  }
}
