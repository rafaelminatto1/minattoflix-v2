async page => {
  await page.unroute('**/api/**');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = request.url().split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/session' && request.method() === 'GET') return route.fulfill({ json: { configured: true, authenticated: false } });
    if (path === '/api/session' && request.method() === 'POST') {
      return request.postDataJSON().code === 'teste-apenas-ui' ? route.fulfill({ json: { token: 'ui-test-only', role: 'viewer' } }) : route.fulfill({ status: 401, json: { error: 'Código inválido.' } });
    }
    if (path === '/api/bootstrap') {
      assert(request.headers().authorization === 'Bearer ui-test-only', 'API request missing session');
      return route.fulfill({ json: { profiles: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Perfil de teste', avatar_url: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', is_kids: false }], catalog: [], genres: [], storageSources: [] } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('http://127.0.0.1:5178/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.getByLabel('Código de acesso').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Login overflows viewport');
  }
  await page.getByLabel('Código de acesso').fill('incorreto');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Código inválido.' }).waitFor();
  await page.getByLabel('Código de acesso').fill('teste-apenas-ui');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('banner').waitFor();
  await page.getByRole('button', { name: 'Sair do acesso' }).click();
  await page.getByLabel('Código de acesso').waitFor();
  assert(await page.evaluate(() => !localStorage.getItem('minatto-session')), 'Logout retained session');
  assert(errors.length === 0, `Page errors: ${errors.join('; ')}`);
  console.log('Acesso validado: celular, desktop, código inválido, entrada, cabeçalho de autorização e saída.');
}
