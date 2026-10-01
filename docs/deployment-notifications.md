# Deployment notifications

Main pushes and manual main runs publish their result to authenticated ntfy after
validation and GitHub Pages finish. Successful deployment alerts link to the site;
failures link to the workflow and identify failed jobs. If Pages deployed while
another validation job failed, the notification describes both results.

Repository configuration:

- Variable `NTFY_URL`: `https://ntfy.stytt.com`
- Variable `NTFY_TOPIC`: `deploy`
- Secret `NTFY_TOKEN`: the dedicated `musical-lights` publisher token

The publisher can only write `deploy`; it cannot read notifications. Never use a
reader or administrator credential here. Pull requests, canceled runs, and
superseded runs that did not deploy do not publish. Notification delivery is
best-effort, has a bounded timeout, and cannot change deployment results.
Delivery errors appear as warnings and in the Actions job summary.

Run the notification behavior tests with:

```sh
python3 -m unittest discover -s validation/notification_tests -v
```
