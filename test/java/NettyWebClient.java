import java.time.Duration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.web.reactive.function.client.WebClient;

/** Spring's WebClient on Reactor Netty, for NettyProbe's `webclient` command: built with Spring. */
public final class NettyWebClient {
  private NettyWebClient() {}

  /** The body of a GET of `url`, through WebClient's default Reactor Netty connector. */
  public static String get(String url) {
    return WebClient.builder()
        .clientConnector(new ReactorClientHttpConnector())
        .build()
        .get()
        .uri(url)
        .retrieve()
        .bodyToMono(String.class)
        .block(Duration.ofSeconds(20));
  }
}
