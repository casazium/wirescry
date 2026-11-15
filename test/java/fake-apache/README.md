# Stand-in Apache classes

Not Apache's code: classes with Apache's names, written here, so test/java-agent-apache.test.ts can make Wirescry's Apache hook fail on purpose. `LoaderProbe fake DIR` loads one set in a class loader of its own.

- `no-method/`: a `DefaultRoutePlanner` without `determineProxy`, so the weave fails and the status file must say `apache:failed`.
- `bad-host/`: a `DefaultRoutePlanner` whose `HttpHost` lacks the constructor the hook builds Wirescry's proxy with, so the hook throws inside the program, and the program's own answer (direct) must stand.
