async function execute(page, scenario, deadline, policyFailed) {
  const steps = [];
  let status = 'PASSED';
  for (const [index, step] of scenario.steps.entries()) {
    try {
      if (Date.now() >= deadline) { const error = new Error(); error.name = 'TimeoutError'; throw error; }
      if (step.action === 'navigate') await page.goto(step.path, { waitUntil: 'domcontentloaded', timeout: Math.min(5000, deadline - Date.now()) });
      else {
        const locator = page.getByTestId(step.testId);
        if (step.action === 'click') await locator.click({ timeout: 2000 });
        else if (step.action === 'fill') await locator.fill({ EMPTY: '', TEXT: 'aipr synthetic input', EMAIL: 'aipr@example.invalid' }[step.fixture], { timeout: 2000 });
        else if (step.action === 'assertVisible' && !(await locator.isVisible())) throw new Error('AssertionFailed');
        else if (step.action === 'assertText' && (await locator.textContent({ timeout: 2000 })) !== step.text) throw new Error('AssertionFailed');
      }
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
