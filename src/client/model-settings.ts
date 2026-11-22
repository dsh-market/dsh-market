/**
 * Take the user to DSH's model settings (Settings → Models).
 *
 * The host gives plugins no call for this, so it goes the way a person would:
 * open Settings, then pick the Models section. Every step is checked; when a
 * step cannot be found the caller says where to go instead.
 */

const SETTINGS_LABEL = /^(设置|Settings|設定)$/i
const MODELS_LABEL = /^(模型|Models|モデル)$/i

function wait(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

async function until<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found !== null && found !== undefined) return found
    if (Date.now() >= deadline) return null
    await wait(40)
  }
}

const labelOf = (el: Element): string => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()

/** The Models entry in an open Settings dialog. */
function modelsEntry(doc: Document): HTMLElement | null {
  for (const dialog of Array.from(doc.querySelectorAll('[role="dialog"]'))) {
    const hit = Array.from(dialog.querySelectorAll<HTMLElement>('[role="tab"],button,a,[role="menuitem"],[role="option"],li'))
      .find(el => MODELS_LABEL.test(labelOf(el)))
    if (hit !== undefined) return hit
  }
  return null
}

const ACCOUNT_MENU_LABEL = /^(账号菜单|Account menu|アカウントメニュー)$/i

/** The sidebar's account menu button (Settings sits in that menu since DSH 0.2.1). */
function accountMenu(doc: Document): HTMLElement | null {
  return Array.from(doc.querySelectorAll<HTMLElement>('button'))
    .find(el => el.closest('[role="dialog"]') === null && ACCOUNT_MENU_LABEL.test((el.getAttribute('aria-label') ?? '').trim())) ?? null
}

/** The Settings item: a button or menu item, or the innermost element that says only "Settings". */
function settingsItem(doc: Document): HTMLElement | null {
  const candidates = Array.from(doc.querySelectorAll<HTMLElement>('[role="menuitem"],button,a,[role="menu"] *'))
    .filter(el => el.closest('[role="dialog"]') === null && SETTINGS_LABEL.test(labelOf(el)))
  // Prefer the actionable element; else the deepest one (its ancestors say the same).
  return candidates.find(el => el.matches('[role="menuitem"],button,a'))
    ?? candidates.find(el => !candidates.some(other => other !== el && el.contains(other)))
    ?? null
}

export async function openModelSettings(doc: Document = document): Promise<boolean> {
  try {
    let entry = modelsEntry(doc)
    if (entry === null) {
      let item = settingsItem(doc)
      if (item === null) {
        const menu = accountMenu(doc)
        if (menu === null) return false
        menu.click()
        item = await until(() => settingsItem(doc), 2000)
      }
      if (item === null) return false
      item.click()
      entry = await until(() => modelsEntry(doc), 3000)
    }
    if (entry === null) return false
    entry.click()
    return true
  } catch {
    return false
  }
}
