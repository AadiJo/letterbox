// Breaks in fetching attachment bytes (crates/core/src/attachments.rs and the adapters'
// `attachment` calls). mutations.ts runs them with the others.

import type { Mutation } from './breaks.ts'

const core = (file: string) => `crates/core/src/${file}`

export const ATTACHMENT_MUTATIONS: Mutation[] = [
  {
    name: "an attachment's chunks go out last first, so the saved file is scrambled",
    file: core('attachments.rs'),
    find: 'for chunk in data.chunks(CHUNK_BYTES) {',
    replace: 'for chunk in data.chunks(CHUNK_BYTES).rev() {',
    scenarios: 'arrives whole and in order',
  },
  {
    name: 'an attachment goes out as one line, however large',
    file: core('attachments.rs'),
    find: 'for chunk in data.chunks(CHUNK_BYTES) {',
    replace: 'for chunk in data.chunks(usize::MAX) {',
    scenarios: 'arrives whole and in order',
  },
  {
    name: "an attachment's answer goes out before its bytes",
    file: core('attachments.rs'),
    find: '        let answer = match result {',
    replace:
      '        if let Ok(AttachmentResult::Bytes(data)) = &result {\n            let file = AttachmentFile { name: listed.name.clone(), mime: listed.mime.clone(), size: data.len() as u64 };\n            self.respond(id.clone(), Response::Attachment(Answer::Ok { ok: letterbox_protocol::True, result: file }));\n        }\n        let answer = match result {',
    also: [
      {
        file: core('attachments.rs'),
        find: '        self.respond(id, Response::Attachment(Answer::from(answer)));\n    }',
        replace:
          '        if answer.is_err() {\n            self.respond(id, Response::Attachment(Answer::from(answer)));\n        }\n    }',
      },
    ],
    scenarios: 'arrives whole and in order',
  },
  {
    name: 'an attachment the provider cannot reach reads as gone, so the user is told it was deleted',
    file: core('attachments.rs'),
    find: '            Err(_) => Err(AttachmentError::Offline),',
    replace: '            Err(_) => Err(AttachmentError::Gone),',
    scenarios: 'offline while the provider is',
  },
  {
    name: 'a blob id the core never made, such as one with a leading zero, names a file',
    file: core('attachments.rs'),
    find: '    (blob_id_of(&message_id, index) == *blob_id).then_some((message_id, index))',
    replace: '    Some((message_id, index))',
    scenarios: 'is answered gone',
  },
  {
    name: 'an attachment over the limit is fetched anyway',
    file: core('attachments.rs'),
    find: '    if listed.size > MAX_BYTES {',
    replace: '    if listed.size > MAX_BYTES && false {',
    scenarios: 'over 50 MiB is refused',
  },
  {
    name: 'gmail: the attachment fetched is the one after the one asked for',
    file: 'crates/gmail/src/message.rs',
    find: '    found.get(index).copied()',
    replace: '    found.get(index + 1).copied()',
    scenarios: 'arrives whole and in order',
  },
  {
    name: 'gmail: a removed message reads as offline, so the user waits for a file that will never come',
    file: 'crates/gmail/src/adapter.rs',
    find: '            Ok(None) => return Ok(AttachmentResult::Gone),',
    replace: '            Ok(None) => return Err(AdapterFailure::Offline),',
    scenarios: 'is answered gone',
  },
]
