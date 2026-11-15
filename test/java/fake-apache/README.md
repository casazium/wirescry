# Stand-in Apache classes

Not Apache's code: classes with Apache's names, written here, so test/java-agent-apache.test.ts can make Wirescry's Apache hook fail on purpose. `LoaderProbe fake DIR` loads one set in a class loader of its own (`shaded DIR` for `shaded/`, `fakesys DIR` for the `system-` ones, which are named as 5.x's `SystemDefaultRoutePlanner`).

- `no-method/`: a `DefaultRoutePlanner` without `determineProxy`, so the weave fails and the status file must say `apache:failed`.
- `bad-host/`: a `DefaultRoutePlanner` whose `HttpHost` lacks the constructor the hook builds Wirescry's proxy with, so the hook throws inside the program, and the program's own answer (direct) must stand.
- `shaded/`: a renamed ("shaded") copy of the planner, as some libraries bundle, under `com.example.shaded.`: the hook doesn't know the name, so it must leave it alone. What shows it is the status file, which must say nothing of Apache: a hook that wove it would report `apache:ok`. Its answer (direct) can't show it, since the hook also checks the planner's exact class name before it answers.
- `system-no-method/`: a `SystemDefaultRoutePlanner` without `determineProxy`: its small hook has nothing to do, and the status file must not say `apache:failed`, since nothing is broken.
- `system-bad-host/`: a `SystemDefaultRoutePlanner` answering Wirescry's address and port as an `HttpHost` without `getAddress`, so its hook throws inside the program, and the program's own answer (the proxy) must stand.
