// The people in `people-first` (people-first.ts) and what they wrote: the mailbox the C2
// design was drawn with. Bodies are whole letters, so previews read like mail, not like the
// subject. Every name, address and company here is made up.

import type { SeedAttachment } from '../contract.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const ME = { name: 'Robin Vale', address: 'robin@vale.test' }

/** The logo Ines signs her HTML mail with. */
export const HARBOUR_LANE_LOGO = 'https://brand.harbourlane.example/logo.png'

export const PEOPLE = {
  maya: { name: 'Maya Lindqvist', address: 'maya@haldenstudio.test' },
  tomas: { name: 'Tomas Okafor', address: 'tomas.okafor@fernmail.test' },
  priya: { name: 'Priya Raman', address: 'priya@ramanpress.test' },
  jonah: { name: 'Jonah Feld', address: 'jonah.feld@fernmail.test' },
  ines: { name: 'Ines Carvalho', address: 'ines@harbourlane.test' },
  wen: { name: 'Wen Zhao', address: 'wen.zhao@ardenmail.test' },
  dara: { name: 'Dara Quinn', address: 'dara@quinnjoinery.test' },
  felix: { name: 'Felix Brandt', address: 'felix@brandt.test' },
  amara: { name: 'Amara Osei', address: 'amara.osei@fernmail.test' },
  leo: { name: 'Leo Marchetti', address: 'leo@marchetti.test' },
  sana: { name: 'Sana Mirza', address: 'sana@mirzalab.test' },
  owen: { name: 'Owen Hale', address: 'owen.hale@studiohale.test' },
  hana: { name: 'Hana Sato', address: 'hana@satotranslate.test' },
  marcus: { name: 'Marcus Bell', address: 'marcus.bell@elmlettings.test' },
  grace: { name: 'Grace Liu', address: 'grace.liu@fernmail.test' },
  ruben: { name: 'Ruben Alves', address: 'ruben@alves.test' },
  noor: { name: 'Noor Haddad', address: 'noor@haddad.test' },
  kit: { name: 'Kit Ashworth', address: 'kit@ashworth.test' },
  ben: { name: 'Ben Adler', address: 'ben.adler@fernmail.test' },
  lena: { name: 'Lena Fischer', address: 'lena@fischerdesign.test' },
} as const

export type Who = keyof typeof PEOPLE

/** The seed's labels, by mailbox key. */
export type Label = 'projects' | 'home' | 'receipts' | 'travel'

/**
 * One message: from them, or from me with `me`. `ago` places one before the last; otherwise
 * they are 20 hours apart. `attachments` are the files it carries. `quotes` ends it with the
 * messages before it, quoted as mail clients quote them: in plain text with `>` lines, or as
 * HTML in Gmail's quote markup (people-first.ts writes it). An HTML one can sign off with a
 * remote `logo` image, which the dev host's fake web serves.
 */
type Say = {
  me?: true
  text: string
  ago?: number
  attachments?: readonly SeedAttachment[]
  quotes?: 'text' | 'html'
  logo?: { url: string; alt: string }
}

/**
 * One conversation with a person: who, about what, when it last moved, its label, its
 * messages oldest first, and whether their last message is still unread. The turn follows
 * from who wrote last, as the core decides it.
 */
export type Conversation = {
  with: Who
  subject: string
  age: number
  label?: Label
  unread?: true
  says: readonly Say[]
}

const letter = (...paragraphs: string[]) => paragraphs.join('\n\n')

/** Where it is my turn: 1 hour to 26 days, newest first. */
const MINE: Conversation[] = [
  {
    with: 'maya',
    subject: 'Notes from Thursday’s workshop',
    age: 1 * HOUR,
    label: 'projects',
    unread: true,
    says: [
      {
        ago: 6 * DAY + 7 * HOUR,
        text: letter(
          'Hi Robin,',
          'Thanks again for hosting on Thursday. I typed up the whiteboard photos and put them in the shared folder, under Workshop, then Notes.',
          'The pricing slide is the one I’m least sure about, so have a look at that one first.',
          'Maya',
        ),
      },
      {
        me: true,
        ago: 5 * DAY + 23 * HOUR,
        text: letter(
          'These look right to me. One thing: the pricing slide still says three tiers, and we agreed on two.',
          'Robin',
        ),
      },
      {
        text: letter(
          'Hi Robin,',
          'Thanks for catching the pricing slide. I’ve fixed it and moved the old three-tier version to the appendix, in case Jules asks why we dropped it.',
          'Two things I still need from you before Monday. First, can you confirm the pilot dates with Northfield? Their ops lead said the week of the 24th works, but I’d rather it came from you, since you’ve been the one talking to their CFO. Second, the budget line for the user interviews is still blank. I pencilled in 12 sessions at €150 each, which matches what we paid last spring. If you want to go bigger, we should say so now.',
          'Separately, Jules wondered whether we should push the public announcement to January. I’m torn. The case study is nearly done and holding it feels like a waste, but a December launch means fielding press questions over the holidays with half the team away.',
          'No rush on that last one, but the pilot dates by Friday would really help.',
          'Maya',
        ),
      },
    ],
  },
  {
    with: 'tomas',
    subject: 'Lease addendum for 4B',
    age: 5 * HOUR,
    label: 'home',
    unread: true,
    says: [
      {
        text: letter(
          'Hi Robin,',
          'Brightwater sent over the addendum for 4B. It’s two pages, and the only real change is the parking clause. They’re moving us from the covered spot to one in the side lot, and taking €20 a month off the rent to make up for it.',
          'I’ve read it twice and it looks fine to me, but you’re on the lease too, so it needs both signatures. If you can sign by Thursday, I’ll drop the paper copy at their office on my way to work on Friday.',
          'Tomas',
        ),
        attachments: [{ name: 'Addendum-4B-signed-TO.pdf', mime: 'application/pdf', size: 217_088 }],
      },
    ],
  },
  {
    with: 'priya',
    subject: 'Cover draft for issue 12',
    age: 26 * HOUR,
    label: 'projects',
    unread: true,
    says: [
      {
        text: letter(
          'Hi Robin,',
          'First pass at the cover for issue 12. Two versions, the darker green and the cream. I’m leaning green, but I’ve stared at it for too long to trust myself.',
          'Priya',
        ),
      },
      {
        me: true,
        text: letter(
          'Green, I think. The cream looks washed out next to the photo. Could the masthead come down a little?',
          'Robin',
        ),
      },
      {
        text: letter(
          'Hi Robin,',
          'Went with the darker green in the end. The masthead still feels a little tight at the top, though, so I’ve dropped it 4 mm and opened up the tracking.',
          'If you’re happy with this one I’ll send it to the printer on Wednesday. They need the final file by noon.',
          'Priya',
        ),
      },
    ],
  },
  {
    with: 'jonah',
    subject: 'Climbing on Saturday?',
    age: 3 * DAY,
    says: [
      {
        text: letter(
          'Hey Robin,',
          'Gym opens at 9. If the weather holds we could drive out to the quarry instead. Sam has a spare rope, so we’d only need your rack.',
          'Let me know by Friday?',
          'Jonah',
        ),
      },
    ],
  },
  {
    with: 'ines',
    subject: 'Invoice 2291, line 4',
    age: 6 * DAY,
    label: 'receipts',
    unread: true,
    says: [
      {
        text: letter(
          'Dear Robin,',
          'Please find invoice 2291 for October attached. Payment is due within 30 days.',
          'Kind regards,\nInes Carvalho\nHarbour Lane Accounts',
        ),
      },
      {
        me: true,
        text: letter(
          'Hi Ines,',
          'Thanks. Line 4 looks off to me. Could you check the hours against the timesheet?',
          'Robin',
        ),
      },
      {
        text: letter(
          'Hi Robin,',
          'Our accounts team flagged line 4. It looks like the October hours were billed twice, once on the weekly sheet and again on the monthly summary.',
          'I can issue a credit note for €380, or reissue the invoice without the line. Which would you prefer for your records?',
          'Ines',
        ),
        quotes: 'html',
        logo: { url: HARBOUR_LANE_LOGO, alt: 'Harbour Lane Accounts' },
      },
    ],
  },
  {
    with: 'wen',
    subject: 'Reference for the Arden fellowship',
    age: 11 * DAY,
    unread: true,
    says: [
      {
        text: letter(
          'Hi Robin,',
          'The portal closes on the 30th. I’ve attached my statement in case it helps you write it. The panel cares most about the community work, so anything you can say about the Saturday workshops would be great.',
          'Thank you again for doing this.',
          'Wen',
        ),
      },
    ],
  },
  {
    with: 'dara',
    subject: 'Quote for the kitchen shelves',
    age: 16 * DAY,
    label: 'home',
    unread: true,
    says: [
      {
        me: true,
        text: letter(
          'Hi Dara,',
          'We’re after three open shelves for the kitchen wall, about 1.2 m each. Could you quote for oak, and for something cheaper?',
          'Robin',
        ),
      },
      {
        text: letter(
          'Hi Robin,',
          'Happy to. I’ll measure up on Thursday if someone’s in. Do you know if there are pipes behind that wall?',
          'Dara',
        ),
        quotes: 'text',
      },
      {
        text: letter(
          'Hi Robin,',
          'Oak comes in at €1,140 fitted, birch ply at €860. Happy to bring samples by next week.',
          'Both prices include the brackets and making good the wall. The ply can be oiled or left raw. Raw marks more easily near the cooker.',
          'Dara',
        ),
        quotes: 'text',
      },
    ],
  },
  {
    with: 'felix',
    subject: 'Photos from the reunion',
    age: 26 * DAY,
    unread: true,
    says: [
      {
        text: letter(
          'Robin!',
          'Finally scanned the film rolls. There are a few of you at the lake I think you’ll like, and one of the whole group on the jetty that came out better than it had any right to.',
          'Want me to post prints, or is a link enough?',
          'Felix',
        ),
        // The reader's attachment states use these: a photo, a big zip, a PDF and a program.
        attachments: [
          { name: 'lake-jetty-1998.jpg', mime: 'image/jpeg', size: 3_250_586 },
          { name: 'reunion-scans-roll-2.zip', mime: 'application/zip', size: 50_960_794 },
          { name: 'contact-sheet.pdf', mime: 'application/pdf', size: 1_468_006 },
          { name: 'RawViewer-setup.exe', mime: 'application/vnd.microsoft.portable-executable', size: 13_002_342 },
        ],
      },
    ],
  },
]

/** Where I wait on them: 2 hours to 29 days, newest first. */
const THEIRS: Conversation[] = [
  {
    with: 'amara',
    subject: 'Dinner next week',
    age: 2 * HOUR,
    says: [
      {
        text: letter(
          'Hi Robin,',
          'We’d love to have you both over next week. Kofi is making the peanut stew again. Which evening suits?',
          'Amara',
        ),
      },
      {
        me: true,
        text: 'Wednesday or Thursday both work for us, whichever is easier with the kids. We’ll bring dessert.',
      },
    ],
  },
  {
    with: 'leo',
    subject: 'Bike for sale',
    age: 7 * HOUR,
    says: [
      { text: 'Hi, yes, it’s the grey one with the 54 cm frame. New chain in the autumn. €240 and it’s yours.' },
      { me: true, text: 'Is it still available? I could come by Sunday afternoon to take a look.' },
    ],
  },
  {
    with: 'sana',
    subject: 'Soil sample results',
    age: 20 * HOUR,
    says: [
      {
        me: true,
        text: 'Any word from the lab? The planting window closes mid-month, so even partial results would help.',
      },
    ],
  },
  {
    with: 'owen',
    subject: 'Studio key handover',
    age: 2 * DAY,
    says: [
      {
        text: letter(
          'Robin,',
          'I’m back from the 12th. Can we sort the studio key before then? I’m around most mornings.',
          'Owen',
        ),
      },
      { me: true, text: 'I can leave the key at the front desk if that’s easier for you.' },
    ],
  },
  {
    with: 'hana',
    subject: 'Brochure translation',
    age: 3 * DAY,
    label: 'travel',
    says: [{ me: true, text: 'Here’s the final English copy. 1,800 words, no rush before the 20th.' }],
  },
  {
    with: 'marcus',
    subject: 'Deposit return',
    age: 5 * DAY,
    says: [
      {
        me: true,
        text: 'Hi Marcus, I moved out of the Elm Street flat on the 31st and left the keys with the agent. When can I expect the deposit back?',
      },
      { text: 'Hi Robin, the inspection is booked for next week. We’ll be in touch after that.' },
      { text: 'Inspection done, all fine. The paperwork is with accounts now.' },
      { me: true, text: 'Following up on the deposit for the Elm Street flat. Any update?' },
    ],
  },
  {
    with: 'grace',
    subject: 'Tickets for the 14th',
    age: 6 * DAY,
    label: 'travel',
    says: [{ me: true, text: 'Count me in for two. Should I send the money now or on the night?' }],
  },
  {
    with: 'ruben',
    subject: 'Desk for the spare room',
    age: 8 * DAY,
    says: [{ me: true, text: 'Would you take €90 if I collect it this weekend?' }],
  },
  {
    with: 'noor',
    subject: 'Choir rota for April',
    age: 12 * DAY,
    says: [
      { text: 'Robin, could you take the first two Sundays in April? Elif is away and I’m short of altos.' },
      { me: true, text: 'The first one, yes. The second clashes with a wedding. Is the 26th any use instead?' },
    ],
  },
  {
    with: 'kit',
    subject: 'Water butts for the garden plots',
    age: 15 * DAY,
    says: [
      {
        me: true,
        text: 'The council will deliver two water butts if one of us signs for them. I can do a weekday morning. Can you?',
      },
    ],
  },
  {
    with: 'ben',
    subject: 'The camera bag I lent you',
    age: 19 * DAY,
    says: [
      { text: 'Still have your camera bag from the wedding. Want it back before your trip?' },
      { me: true, text: 'Yes please, if you’re passing. Leave it with Tomas if I’m out.' },
    ],
  },
  {
    with: 'lena',
    subject: 'Logo files for the shop',
    age: 29 * DAY,
    label: 'projects',
    says: [
      { me: true, text: 'Could you send the logo as an SVG as well? The sign maker can’t use the PNG at that size.' },
    ],
  },
]

/**
 * Turns older than 30 days, alternating mine and theirs, 13 days apart: one line each, from
 * them on my turn and from me on theirs.
 */
const RETIRED: Conversation[] = (
  [
    ['Housewarming', 'maya', 'We’re finally in. Drinks on the 3rd, nothing fancy.'],
    ['Recipe you asked about', 'tomas', 'Here’s the dal recipe. The trick is the second tempering.'],
    ['Moving boxes', 'priya', 'Do you still have those moving boxes? I need about ten.'],
    ['Piano tuner', 'jonah', 'Her number is in the hall. She’s booked up until the spring, though.'],
    ['Tax documents', 'ines', 'Could you send the P60 when you have a minute?'],
    ['Wedding playlist', 'wen', 'I’ve added the songs you sent. Too much Motown?'],
    ['Lost scarf', 'dara', 'Is a green scarf yours? Found it after the dinner.'],
    ['Choir schedule', 'felix', 'Rehearsals move to Tuesdays from next month.'],
    ['Camera lens', 'amara', 'The 35 mm is yours to borrow whenever you like.'],
    ['Allotment shed', 'leo', 'The shed roof needs felt before the winter. Split the cost?'],
    ['Recommendation for a dentist', 'sana', 'Dr Okoro on Mill Lane is gentle and runs on time.'],
    ['Car share', 'owen', 'I can drive on Mondays and Wednesdays if you take Fridays.'],
    ['Birthday plans', 'noor', 'Thinking of the Lebanese place for Sami’s birthday. Thoughts?'],
    ['Old laptop', 'kit', 'If you still want the old laptop, it’s wiped and ready.'],
    ['Language exchange', 'maya', 'My cousin is looking for an English partner, an hour a week.'],
    ['Volunteer shifts', 'tomas', 'Put me down for the Saturday morning shift at the food bank.'],
    ['Paint colours', 'priya', 'We went with the second grey in the end. It looks warmer at night.'],
    ['Train tickets', 'jonah', 'Booked the 8:12. Coach C, seats 41 and 42.'],
    ['Running club', 'ines', 'Thursday runs start from the bandstand at 7.'],
    ['Holiday cottage', 'wen', 'The cottage is free in the last week of August, if you want it.'],
    ['Ceramics class', 'dara', 'The class has two spaces left for the spring term.'],
    ['Window repair', 'felix', 'The glazier can come on the 9th between 8 and 10.'],
    ['Podcast idea', 'amara', 'What if each episode was one street, told by the people on it?'],
    ['School fundraiser', 'leo', 'Could you do an hour on the cake stall on Saturday?'],
    ['Chess rematch', 'sana', 'Rematch on Sunday? I’ve been studying.'],
    ['Board game night', 'owen', 'Board games at ours on Friday. Bring the new one.'],
    ['Plant cuttings', 'noor', 'The pothos cuttings have rooted. Want two?'],
  ] as const
).map(([subject, person, text], index): Conversation => ({
  with: person,
  subject,
  age: (31 + index * 13) * DAY,
  says: [index % 2 === 0 ? { text } : { me: true, text }],
}))

export const CONVERSATIONS = [...MINE, ...THEIRS, ...RETIRED]

/** When each message of `conversation` was sent, as ms before now, oldest first. */
export const agesOf = (conversation: Conversation) =>
  conversation.says.map(
    (say, index) => say.ago ?? conversation.age + (conversation.says.length - 1 - index) * 20 * HOUR,
  )
