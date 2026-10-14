async function execute(page, scenario, deadline, policyFailed, approvedOrigin, control) {
  const steps = [];
  let status = 'PASSED';
  for (const [index, step] of scenario.steps.entries()) {
    try {
      if (Date.now() >= deadline) { const error = new Error(); error.name = 'TimeoutError'; throw error; }
      if (step.action === 'navigate') await page.goto(step.path, { waitUntil: 'domcontentloaded', timeout: Math.min(5000, deadline - Date.now()) });
      else if (step.action === 'authenticate' || step.action === 'assertJson') {
        if (new URL(page.url()).origin !== approvedOrigin || !control) throw new Error('ControlUnavailable');
        if (!(await control(index))) throw new Error('AssertionFailed');
      } else {
        if (new URL(page.url()).origin !== approvedOrigin) throw new Error('OriginBlocked');
        const locator = page.getByTestId(step.testId);
        if (step.action === 'click') await locator.click({ timeout: 2000 });
        else if (step.action === 'fill') await locator.fill({ EMPTY: '', TEXT: 'aipr synthetic input', EMAIL: 'aipr@example.invalid' }[step.fixture], { timeout: 2000 });
        else if (step.action === 'assertVisible' || step.action === 'assertText') {
          const until = Math.min(deadline, Date.now() + 2000);
          let matched = false;
          do {
            matched = step.action === 'assertVisible' ? await locator.isVisible() : (await locator.textContent({ timeout: Math.max(1, until - Date.now()) })) === step.text;
            if (!matched) await new Promise(resolve => setTimeout(resolve, 50));
          } while (!matched && Date.now() < until);
          if (!matched) throw new Error('AssertionFailed');
        }
      }
      if (new URL(page.url()).origin !== approvedOrigin) throw new Error('OriginBlocked');
      steps.push({ index, status: 'PASSED' });
    } catch (error) {
      status = error.name === 'TimeoutError' ? 'TIMED_OUT' : error.message === 'AssertionFailed' ? 'FAILED' : 'ERROR';
      steps.push({ index, status });
      break;
    }
  }
  if (policyFailed()) status = 'ERROR';
  return { id: scenario.id, status, steps };
}
module.exports = { execute };
