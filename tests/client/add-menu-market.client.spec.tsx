// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AddMenuMarketItem } from '../../src/client/AddMenuMarketItem.tsx'

afterEach(() => { cleanup(); document.body.innerHTML = '' })

it('closes the Add plugin menu and selects the market tab on the Plugins page', async () => {
  const tab = document.createElement('div')
  tab.setAttribute('role', 'tab')
  tab.id = 'plugins-tab-dsh-market'
  const clicked = vi.fn()
  tab.addEventListener('click', clicked)
  document.body.appendChild(tab)
  const onDismiss = vi.fn()
  render(<AddMenuMarketItem t={(k: string) => k} onDismiss={onDismiss} />)
  fireEvent.click(screen.getByText('addMenuMarket'))
  expect(onDismiss).toHaveBeenCalledOnce()
  await waitFor(() => expect(clicked).toHaveBeenCalledOnce())
  expect(screen.getByText('addMenuMarketHint')).toBeTruthy()
})

it('opens the Plugins page first when the market tab is not in view', async () => {
  const openList = vi.fn(() => {
    const tab = document.createElement('div')
    tab.setAttribute('role', 'tab')
    tab.id = 'x-dsh-market'
    tab.addEventListener('click', () => { tab.dataset.clicked = '1' })
    document.body.appendChild(tab)
  })
  const navigation = { get: () => ({ openBundle: () => {}, openList }) } as never
  render(<AddMenuMarketItem t={(k: string) => k} navigation={navigation} />)
  fireEvent.click(screen.getByText('addMenuMarket'))
  await waitFor(() => expect(document.querySelector('[data-clicked="1"]')).toBeTruthy())
  expect(openList).toHaveBeenCalledOnce()
})
