package reactor.netty.transport;

/** Stand-in: see test/java/fake-netty/README.md. */
public abstract class ClientTransportConfig extends TransportConfig {
  public final boolean hasProxy() {
    return false;
  }
}
