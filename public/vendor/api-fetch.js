/**
 * CSRF対応 fetch ラッパー
 * csrf_token cookieから値を読み取り X-CSRF-Token ヘッダーとして送信する
 */
async function apiFetch(url, opts = {}) {
  const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/)?.[1] || '';
  opts.headers = Object.assign({}, opts.headers || {}, { 'X-CSRF-Token': csrf });
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  return fetch(url, opts);
}
