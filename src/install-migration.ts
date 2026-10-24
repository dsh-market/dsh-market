/** Known package renames that require the publisher's settings-preserving
 * migration. Guidance only: never runs code, removes a package or changes a
 * source automatically. Keep the duplicate-ID protection in place. */
export function installMigrationHelp(url: string, installed: Record<string, string>): { code: string; error: string; migrationGuide: string } | null {
  if (url.toLowerCase().replace(/\/$/, '') !== 'https://github.com/kingcharleslzy-ai/dsh-purge'
    || !Object.hasOwn(installed, 'dsh-purge') || Object.hasOwn(installed, 'dsh-purge-community')) return null
  const migrationGuide = 'https://github.com/kingcharleslzy-ai/dsh-purge/blob/master/docs/MARKET-MIGRATION.md'
  return {
    code: 'migration-required',
    migrationGuide,
    error: `检测到旧版 Purge。请用项目的迁移安装器保留设置升级，无需卸载。说明：${migrationGuide} / Legacy Purge is installed. Use the project's migration installer to preserve settings; do not uninstall first.`,
  }
}
