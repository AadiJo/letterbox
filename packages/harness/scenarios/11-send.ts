// Sending: a reply or a new message shows at once, waits out its undo window, reaches the
// provider exactly once, and settles into the copy the provider keeps. Each scenario is one
// way a send could be lost, doubled, shown wrongly or sent when the user took it back.

import type { ChangeId, ThreadDetail } from '@letterbox/protocol'
import { ME, mailbox, openThread, readThread, start, sync, thread, threads, untilAccounts } from '../src/fixtures.ts'
import { HELD_WINDOW, scenario } from '../src/scenario.ts'
import { ASKED, asked, draft, idsOf, startWith } from '../src/sending.ts'

scenario('a reply shows at once, hands the turn over, and settles into one copy', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  t.equal((await thread(core, ASKED)).turn.holder, 'mine', 'Ben asked, so it is my turn')
  const open = await openThread(core, threadId)
  const seen: ThreadDetail[] = []
  open.watch(() => {
    const detail = open.latest()
    if (detail) seen.push(detail)
  })

  const answer = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal(answer.kind, 'accepted', 'the send is accepted')
  const settled = await core.settled(answer.change)
  t.equal(settled.result, 'done', 'it settles as done')

  const first = seen[0]
  const reply = first?.messages[1]
  t.equal(
    [first?.messages.length, reply?.delivery?.state, first?.turn, first?.pending],
    [2, 'held', { holder: 'theirs', reason: 'i-wrote-last' }, true],
    'the first update shows the reply in its undo window, pending, and the turn is theirs',
  )
  t.equal(
    [reply?.from.address, reply?.unread, reply?.body.state],
    [ME, false, 'ready'],
    'the reply is mine, read, and its body is there',
  )
  t.check(
    seen.every((detail) => detail.messages.length === 2 && detail.messages[1]?.id === reply?.id),
    'every update until it settled shows the reply once, under one id',
  )
  const last = open.latest()
  t.equal([last?.messages[1]?.delivery, last?.pending], [null, false], 'settled, it is the provider copy')
  t.check((await mailbox(core, 'Sent')).total >= 2, 'the reply counts in Sent with the earlier one')

  const copies = box.sent()
  t.equal(copies.length, 1, 'the provider got it once')
  const raw = copies[0]?.raw ?? ''
  t.check(
    raw.includes('In-Reply-To: <review@sim.test>') && raw.includes('References: <review@sim.test>'),
    'it answers the question by In-Reply-To and References',
  )
  t.equal(copies[0]?.recipients, ['ben@example.com'], 'it went to Ben')

  // Settled, the reply is the provider's copy, so a change to its conversation reaches that copy.
  const flag = await core.command({ kind: 'set-flags', threadIds: [threadId], flagged: true })
  t.equal((await core.settled(flag.change)).result, 'done', 'flagging the conversation settles')
  t.equal(
    box.truth().find((message) => message.key === 'sent-1')?.flagged,
    true,
    'the flag reached the provider copy of the reply, before any sync',
  )

  // A full resync lists the mailbox again. The provider's copy must match the reply the core holds.
  box.expireCursors()
  await sync(core)
  const after = await readThread(core, threadId)
  t.equal(idsOf(after), idsOf(last), 'after a full resync the conversation has the same two messages')
  t.equal((await threads(core)).length, 5, 'no conversation was added')
})

scenario('a new message starts a conversation of its own', async (t) => {
  const { core, box, accountId } = await start(t)
  // Long and not ASCII, so it travels as several encoded words the provider has to read back.
  const subject = 'Plans for the spring ☀ and a subject long enough to take more than one encoded word'
  const message = draft(accountId, null, {
    to: ['ana@example.com'],
    cc: ['ben@example.com'],
    bcc: ['cara@example.com'],
    subject,
    text: 'Shall we plan the spring trip?',
    html: '<p>Shall we plan the spring trip?</p>',
  })
  const answer = await core.command({ kind: 'send', draft: message })
  t.equal((await core.settled(answer.change)).result, 'done', 'it settles as done')
  const row = await thread(core, subject)
  t.equal(
    [row.messageCount, row.turn.holder, row.mailboxIds, row.pending],
    [1, 'theirs', [(await mailbox(core, 'Sent')).id], false],
    'a new conversation in Sent, with the turn theirs',
  )
  const sent = box.sent()[0]
  t.equal(sent?.recipients, ['ana@example.com', 'ben@example.com', 'cara@example.com'], 'it went to To, Cc and Bcc')
  t.check(!/^Bcc:/im.test(sent?.raw ?? ''), 'no recipient sees the Bcc')
  const detail = await readThread(core, row.id)
  const body = detail?.messages[0]?.body
  t.equal(
    body?.state === 'ready' && [body.text, body.html],
    ['Shall we plan the spring trip?', '<p>Shall we plan the spring trip?</p>'],
    'its text and html are both kept',
  )
  box.expireCursors()
  await sync(core)
  t.equal((await thread(core, subject)).id, row.id, 'a full resync finds the same conversation under its subject')
  t.equal((await threads(core)).length, 6, 'and no second one')
})

scenario('undo inside the window cancels the send, and the provider never sees it', async (t) => {
  const { core, box, accountId } = await startWith(t, { undoWindow: HELD_WINDOW })
  const { threadId, question } = await asked(core)
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  const held = await readThread(core, threadId)
  t.equal(held?.messages[1]?.delivery?.state, 'held', 'the reply waits in its undo window')

  const undo = await core.command({ kind: 'undo', change: send.change })
  t.equal(undo.kind, 'accepted', 'the undo is accepted')
  t.equal(
    [(await core.settled(send.change)).result, (await core.settled(undo.change)).result],
    ['undone', 'done'],
    'the send settles as undone and the undo as done',
  )
  const after = await readThread(core, threadId)
  t.equal(
    [idsOf(after), after?.turn.holder, after?.pending],
    [[question.id], 'mine', false],
    'the reply is gone and the turn is mine again',
  )
  await sync(core)
  t.equal([box.calls().send, box.sent()], [0, []], 'the provider was never asked to send it')
})

scenario('undo after the window is refused, since mail cannot be unsent', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal((await core.settled(send.change)).result, 'done', 'the window ends and the send goes out')
  const undo = await core.command({ kind: 'undo', change: send.change })
  t.equal(undo.kind === 'rejected' && undo.reason, 'conflict', 'the undo is rejected as too late')
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'the reply stays')
  t.equal(box.sent().length, 1, 'the provider holds one copy')
})

scenario('a send the provider refuses stays in its conversation, marked failed', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  box.refuseNextSend('refused-by-provider')
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  t.equal(
    (await core.settled(send.change)).result,
    { failed: 'refused-by-provider' },
    'it settles as failed with the reason',
  )
  const detail = await readThread(core, threadId)
  t.equal(
    [detail?.messages.length, detail?.messages[1]?.delivery, detail?.pending],
    [2, { state: 'failed', change: send.change, reason: 'refused-by-provider' }, false],
    'the reply is still shown, failed, and nothing is pending',
  )
  box.expireCursors()
  await sync(core)
  t.equal(
    (await readThread(core, threadId))?.messages[1]?.delivery?.state,
    'failed',
    'a full resync keeps the failed reply',
  )
  t.equal(box.sent(), [], 'the provider holds no copy')
})

scenario('a send made offline goes out once the provider is back', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  box.setOffline(true)
  const accounts = core.subscribe({ view: 'accounts' })
  const send = await core.command({ kind: 'send', draft: draft(accountId, question.id) })
  // Its window ends and its push finds the provider unreachable. Waiting for that fixes the order.
  await untilAccounts(accounts, (list) => list[0]?.status.state === 'offline')
  const waiting = await readThread(core, threadId)
  t.equal(
    [waiting?.messages[1]?.delivery?.state, waiting?.pending],
    ['sending', true],
    'the reply waits for the provider, past its window',
  )
  const late = await core.command({ kind: 'undo', change: send.change })
  t.equal(late.kind === 'rejected' && late.reason, 'conflict', 'it can no longer be undone')
  box.setOffline(false)
  await sync(core)
  t.equal((await core.settled(send.change)).result, 'done', 'it settles once the provider is reachable')
  t.equal([box.sent().length, box.calls().send], [1, 1], 'the provider got it once')
})

scenario('a restart inside the undo window loses nothing and sends once', async (t) => {
  const first = await startWith(t, { undoWindow: HELD_WINDOW })
  const { threadId, question } = await asked(first.core)
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  t.equal(send.kind, 'accepted', 'the send is accepted')
  await first.core.stop()
  t.equal(first.box.sent(), [], 'the stopped core sent nothing')

  // Two hours on, the window ended while the core was stopped.
  const core = t.startCore({ now: '2026-01-01T02:00:00.000Z' })
  await core.hello()
  t.equal((await core.settled(send.change)).result, 'done', 'the restarted core sends it')
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'the conversation shows it once')
  await sync(core)
  t.equal(first.box.sent().length, 1, 'the provider got it once')
})

scenario('a core killed in the middle of a delivery sends it once after the restart', async (t) => {
  const first = await start(t)
  const { threadId, question } = await asked(first.core)
  first.box.holdSends()
  const send = await first.core.command({ kind: 'send', draft: draft(first.accountId, question.id) })
  await first.box.sendHeld()
  await first.core.kill()
  // The provider takes the message, but the core is gone before it hears so.
  first.box.releaseSends()
  t.equal(first.box.sent().length, 1, 'the provider holds the message')

  const core = t.startCore()
  await core.hello()
  t.equal(
    (await readThread(core, threadId))?.messages[1]?.delivery?.state,
    'sending',
    'the restarted core still shows the reply on its way',
  )
  await sync(core)
  t.equal((await core.settled(send.change)).result, 'done', 'it settles as done')
  t.equal(first.box.sent().length, 1, 'the provider still holds one copy, not two')
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'the conversation shows it once')
})

scenario('sending the same send twice has one effect', async (t) => {
  const { core, box, accountId } = await start(t)
  const { threadId, question } = await asked(core)
  const change = 'change_send_twice' as ChangeId
  const first = await core.command({ kind: 'send', draft: draft(accountId, question.id) }, change)
  const again = await core.command({ kind: 'send', draft: draft(accountId, question.id) }, change)
  t.check(
    first.kind === 'accepted' && again.kind === 'accepted' && first.rev === again.rev,
    'the second send is answered with the first revision',
  )
  t.equal((await core.settled(change)).result, 'done', 'it settles as done')
  t.equal((await readThread(core, threadId))?.messages.length, 2, 'the conversation shows one reply')
  t.equal(box.sent().length, 1, 'the provider got one copy')
})
