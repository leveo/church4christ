// Browser-safe shared contract for the People import HTTP result envelope.
// Keep this module dependency-free: both server routes and the admin controller
// import it, so adding persistence or Astro imports here would leak server code
// into the client bundle.
export const PEOPLE_IMPORT_HTTP_RESULT_CODES = [
  'multipart_required',
  'multipart_invalid',
  'missing_file',
  'file_too_large',
  'file_type_invalid',
  'validation_failed',
  'warnings_not_acknowledged',
  'import_conflict',
  'import_failed',
  'generic_error',
  'forbidden',
  'not_found',
  'method_not_allowed',
] as const;

export type PeopleImportHttpResultCode = (typeof PEOPLE_IMPORT_HTTP_RESULT_CODES)[number];
