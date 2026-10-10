FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /runner
COPY packages/behavioral-runner/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY packages/behavioral-runner/browser-child.cjs ./browser-child.cjs
COPY packages/behavioral-runner/actions.cjs ./actions.cjs
COPY apps/backend/dist/services/behavioral/contracts.js ./contracts.js
USER pwuser
ENTRYPOINT ["node", "/runner/browser-child.cjs"]
