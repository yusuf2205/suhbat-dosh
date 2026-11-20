// Word / Excel / PowerPoint and similar: served with their real type, so a phone hands them to the program that opens them instead of saving them.
export const OFFICE = {
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf', csv: 'text/csv; charset=utf-8',
};
export const officeMime = (name) => OFFICE[(String(name || '').split('.').pop() || '').toLowerCase()] || null;
