// Browser-safe result-code contract for source-column mapping HTTP endpoints.
// Keep this module dependency-free so the later admin controller can import it.
export const PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES = [
  'multipart_required',
  'multipart_invalid',
  'missing_file',
  'file_too_large',
  'file_type_invalid',
  'mapping_config_too_large',
  'mapping_config_invalid',
  'mapping_source_invalid',
  'profile_name_invalid',
  'profile_id_invalid',
  'mapping_profile_invalid',
  'mapping_profile_conflict',
  'mapping_profile_corrupt',
  'mapping_profile_failed',
  'mapping_profile_not_found',
  'validation_failed',
  'warnings_not_acknowledged',
  'import_conflict',
  'import_failed',
  'generic_error',
  'forbidden',
  'not_found',
  'method_not_allowed',
] as const;

export type PeopleImportMappingHttpResultCode =
  (typeof PEOPLE_IMPORT_MAPPING_HTTP_RESULT_CODES)[number];
