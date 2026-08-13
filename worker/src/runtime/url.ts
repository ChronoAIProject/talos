export const resolveControlPlaneUrl = (base: string, path: string): URL => {
  const baseUrl = new URL(base);
  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  baseUrl.search = '';
  baseUrl.hash = '';
  return new URL(path.replace(/^\/+/, ''), baseUrl);
};
