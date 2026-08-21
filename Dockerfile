# Healer agent image. Carries the fixed healing logic (scripts/) + orchestrator
# (agent/) and everything needed to run all three test suites, so at runtime it
# can clone a PR branch and diagnose/heal it itself — no GitHub Actions runner.
#
# Based on Microsoft's official Playwright image (pinned to the repo's
# @playwright/test version) so Chromium + all its OS libraries are already
# present — no `apt`/`playwright install --with-deps` at build time. Node and
# git ship in this image too.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# pip via HTTPS (get-pip.py) rather than apt, so pytest + pytest-json-report
# are on PATH for every cloned workspace. Avoids the Debian/Ubuntu package
# mirrors entirely.
RUN curl -sSL https://bootstrap.pypa.io/get-pip.py -o /tmp/get-pip.py \
  && python3 /tmp/get-pip.py --break-system-packages \
  && rm /tmp/get-pip.py
COPY requirements-dev.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements-dev.txt

# The tamper-proof healing logic + orchestrator. App/test files come from the
# PR via git clone at runtime and never overwrite these.
COPY scripts/ ./scripts/
COPY agent/ ./agent/

# Use the browsers already baked into the base image; the workspace's local
# @playwright/test (same pinned version) finds them here instead of downloading.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENTRYPOINT ["node", "agent/cli.js"]
