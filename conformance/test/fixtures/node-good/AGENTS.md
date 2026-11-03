# Starter: TypeScript

This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.
This fixture stands in for a real stack section. It explains the commands, the layout, sign-in, email, jobs and events.

- **Business logic:** keep it in the app's code, not in database triggers. Use a trigger only for simple per-row bookkeeping, such as setting `updated_at`: a trigger hides behaviour from the code a reviewer reads, and agent.cloud's masked copies and migration checks handle triggers poorly.
- **A lake call:** give the lake client a timeout, or each call a deadline, and handle the timeout as a failure the caller sees; agent.cloud's review files a call with neither as `lake-no-deadline`.
