import { makeRecordId } from './crypto';
import { Csv, TimeFmt } from './csvAndTime';
import { PlainRecord, RecordType } from './types';

export function callTypeFromRaw(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const asInt = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asInt) && String(asInt) === trimmed) {
    switch (asInt) {
      case 1:
        return 'incoming';
      case 2:
        return 'outgoing';
      case 3:
        return 'missed';
      case 4:
        return 'voicemail';
      case 5:
        return 'rejected';
      case 6:
        return 'blocked';
      default:
        return 'other';
    }
  }
  switch (trimmed) {
    case 'incoming':
    case 'in':
      return 'incoming';
    case 'outgoing':
    case 'out':
      return 'outgoing';
    case 'missed':
      return 'missed';
    case 'rejected':
      return 'rejected';
    case 'blocked':
      return 'blocked';
    case 'voicemail':
      return 'voicemail';
    default:
      return 'other';
  }
}

export function smsTypeFromRaw(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const asInt = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asInt) && String(asInt) === trimmed) {
    switch (asInt) {
      case 1:
        return 'inbox';
      case 2:
        return 'sent';
      case 3:
        return 'draft';
      case 4:
        return 'outbox';
      case 5:
        return 'failed';
      case 6:
        return 'queued';
      default:
        return 'other';
    }
  }
  switch (trimmed) {
    case 'inbox':
    case 'received':
    case 'in':
      return 'inbox';
    case 'sent':
    case 'out':
      return 'sent';
    case 'draft':
      return 'draft';
    case 'outbox':
      return 'outbox';
    case 'failed':
      return 'failed';
    case 'queued':
      return 'queued';
    default:
      return 'other';
  }
}

export const RecBuilder = {
  async call(
    deviceId: string,
    number: string,
    ts: number,
    type: string,
    durationSec: number,
    name?: string | null
  ): Promise<PlainRecord> {
    const cleanNum = number.trim();
    const cleanName = name?.trim() || undefined;
    const fields: Record<string, string | number | undefined> = {
      number: cleanNum,
      type,
      durationSec: Math.max(0, Math.trunc(durationSec || 0)),
    };
    if (cleanName) {
      fields.name = cleanName;
    }
    const id = await makeRecordId(deviceId, RecordType.CALL, cleanNum, ts, type, fields.durationSec);
    return { id, deviceId, type: RecordType.CALL, ts, fields };
  },

  async sms(
    deviceId: string,
    address: string,
    body: string,
    ts: number,
    type: string
  ): Promise<PlainRecord> {
    const cleanAddr = address.trim();
    const id = await makeRecordId(deviceId, RecordType.SMS, cleanAddr, ts, type, body);
    return {
      id,
      deviceId,
      type: RecordType.SMS,
      ts,
      fields: { address: cleanAddr, body, type },
    };
  },

  async clip(deviceId: string, text: string, ts: number): Promise<PlainRecord> {
    const cleanText = text.trim();
    // Deterministic ID derived from text only so identical clipboard text is never duplicated
    const id = await makeRecordId(deviceId, RecordType.CLIP, cleanText);
    return {
      id,
      deviceId,
      type: RecordType.CLIP,
      ts,
      fields: { text: cleanText },
    };
  },
};

export function isValidPlainRecord(r: PlainRecord): boolean {
  if (!Number.isFinite(r.ts) || r.ts <= 0) return false;
  switch (r.type) {
    case RecordType.CALL:
      return true; // Caller ID may be blank for private/withheld numbers
    case RecordType.SMS:
      return String(r.fields.address ?? '').trim().length > 0;
    case RecordType.CLIP:
      return String(r.fields.text ?? '').trim().length > 0;
    default:
      return false;
  }
}

function findHeaderIndex(headers: string[], ...candidates: string[]): number {
  return headers.findIndex((h) => candidates.includes(h.trim().toLowerCase()));
}

export interface ParsedImportBatch {
  records: PlainRecord[];
  skipped: number;
}

export const Importer = {
  async callsFromCsv(deviceId: string, text: string): Promise<ParsedImportBatch> {
    const rows = Csv.parse(text).filter((r) => r.some((cell) => cell.trim().length > 0));
    if (rows.length < 2) return { records: [], skipped: 0 };
    const headers = rows[0];
    const iNum = findHeaderIndex(headers, 'number', 'phone', 'phone_number');
    const iType = findHeaderIndex(headers, 'type', 'call_type');
    const iDate = findHeaderIndex(headers, 'date', 'time', 'timestamp', 'datetime');
    const iDur = findHeaderIndex(headers, 'duration', 'duration_sec');
    const iName = findHeaderIndex(headers, 'name', 'contact', 'contact_name');

    if (iNum < 0 || iDate < 0) {
      return { records: [], skipped: rows.length - 1 };
    }

    let skipped = 0;
    const records: PlainRecord[] = [];
    for (const row of rows.slice(1)) {
      const ts = row[iDate] ? TimeFmt.parse(row[iDate]) : null;
      if (!ts || ts <= 0) {
        skipped++;
        continue;
      }
      const type = iType >= 0 ? callTypeFromRaw(row[iType] ?? '') : 'other';
      const dur = iDur >= 0 ? Number.parseInt((row[iDur] ?? '').trim(), 10) || 0 : 0;
      const name = iName >= 0 ? row[iName] : undefined;
      records.push(await RecBuilder.call(deviceId, row[iNum] ?? '', ts, type, dur, name));
    }
    return { records, skipped };
  },

  async smsFromCsv(deviceId: string, text: string): Promise<ParsedImportBatch> {
    const rows = Csv.parse(text).filter((r) => r.some((cell) => cell.trim().length > 0));
    if (rows.length < 2) return { records: [], skipped: 0 };
    const headers = rows[0];
    const iAddr = findHeaderIndex(headers, 'address', 'number', 'from', 'to', 'phone');
    const iBody = findHeaderIndex(headers, 'body', 'text', 'message');
    const iDate = findHeaderIndex(headers, 'date', 'time', 'timestamp', 'datetime');
    const iType = findHeaderIndex(headers, 'type');

    if (iAddr < 0 || iBody < 0 || iDate < 0) {
      return { records: [], skipped: rows.length - 1 };
    }

    let skipped = 0;
    const records: PlainRecord[] = [];
    for (const row of rows.slice(1)) {
      const ts = row[iDate] ? TimeFmt.parse(row[iDate]) : null;
      const addr = (row[iAddr] ?? '').trim();
      if (!ts || ts <= 0 || !addr) {
        skipped++;
        continue;
      }
      const type = iType >= 0 ? smsTypeFromRaw(row[iType] ?? '') : 'other';
      records.push(await RecBuilder.sms(deviceId, addr, row[iBody] ?? '', ts, type));
    }
    return { records, skipped };
  },

  async smsFromXml(deviceId: string, xmlText: string): Promise<ParsedImportBatch> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('XMLParseError');
    }

    const smsNodes = Array.from(doc.getElementsByTagName('sms'));
    let skipped = 0;
    const records: PlainRecord[] = [];

    for (const node of smsNodes) {
      const addr = (node.getAttribute('address') ?? '').trim();
      const rawDate = node.getAttribute('date') ?? '';
      const ts = TimeFmt.parse(rawDate);
      if (!addr || !ts || ts <= 0) {
        skipped++;
        continue;
      }
      const body = node.getAttribute('body') ?? '';
      const rawType = node.getAttribute('type') ?? '0';
      records.push(await RecBuilder.sms(deviceId, addr, body, ts, smsTypeFromRaw(rawType)));
    }
    return { records, skipped };
  },

  sampleCallsCsvTemplate(): string {
    const now = Date.now();
    return (
      '\uFEFF' +
      [
        'number,type,date,duration,name',
        `+966501234567,incoming,${now - 3600_000},145,أحمد العتيبي`,
        `+966559876543,outgoing,${now - 7200_000},62,مكتب العمل`,
        `+966500001122,missed,${now - 10800_000},0,`,
      ].join('\r\n') +
      '\r\n'
    );
  },

  sampleSmsXmlTemplate(): string {
    const now = Date.now();
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<smses count="2">',
      `  <sms address="+966501234567" date="${now - 1800_000}" type="1" body="مرحبًا، تم تأكيد موعد الاجتماع غدًا الساعة العاشرة صباحًا." />`,
      `  <sms address="+966559876543" date="${now - 5400_000}" type="2" body="تم إرسال المستندات المطلوبة عبر البريد الرسمي." />`,
      '</smses>',
    ].join('\n');
  },
};
