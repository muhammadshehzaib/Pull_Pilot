# Browser sandbox requirements

The image is pinned to the registry manifest digest for Playwright 1.64.0 Noble,
matching the installed package. The browser runs as `pwuser`, with Chromium's
sandbox explicitly enabled, a read-only root filesystem, no external network,
no Linux capabilities, no privilege escalation, and bounded resources.

`chromium-seccomp.json` is the version-matched upstream profile from
https://github.com/microsoft/playwright/blob/v1.64.0/utils/docker/seccomp_profile.json
(Microsoft Playwright, Apache-2.0). It uses a default-deny policy and permits the
user namespace operations needed by Chromium. Keep it alongside the trusted CLI
checkout: Docker reads the profile from the host, not inside the browser image.

The Linux host must permit unprivileged user namespaces. If sandbox launch fails,
the run fails; do not add `--no-sandbox`, privileged mode, `SYS_ADMIN`, or an
unconfined seccomp profile. Test a disposable run on the deployment host before
enabling customer execution. The unit test checks launch/options and failure
behavior; it does not establish that a particular host kernel can sandbox Chrome.
