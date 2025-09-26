-- migrate core_persona from jsonb to text
ALTER TABLE visitor_templates
  ALTER COLUMN core_persona TYPE text USING (
    CASE
      WHEN jsonb_typeof(core_persona) IS NULL THEN ''
      WHEN jsonb_typeof(core_persona) = 'string' THEN core_persona::text
      ELSE to_jsonb(core_persona)::text
    END
  );

-- ensure not null
ALTER TABLE visitor_templates
  ALTER COLUMN core_persona SET NOT NULL;

