import { expect, mock, test } from 'claude-code/testing'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`shows the sign-in screen when no GitHub account is found (${surface})`, async ($, on) => {
    on('process.run', () => {
      throw new Error('gh: not found')
    })
    mock.clock(on, { now: 1_700_000_000_000 })
    on('ui.status', () => ({ value: undefined }))

    const pane = await $.ui.mount({
      plugin: 'repo-radar',
      surface,
      component: 'Pane',
      requestId: 'repo-radar',
      props: { bodyColumns: 80 } as never,
    })
    expect(await pane.find({ text: /Sweeping/ })).toBeTruthy()

    await $.ui.press({ plugin: 'repo-radar', key: 'refresh', surface })
    expect(await pane.find({ text: /No GitHub account/ })).toBeTruthy()
    expect(await pane.find({ text: /gh auth login/ })).toBeTruthy()
  })
}
