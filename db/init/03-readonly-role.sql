\getenv reader_password POLICYGRAPH_READER_PASSWORD

SELECT format('CREATE ROLE policygraph_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD %L', :'reader_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'policygraph_reader')
\gexec

SELECT format('ALTER ROLE policygraph_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD %L', :'reader_password')
\gexec

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_auth_members
        WHERE member = (SELECT oid FROM pg_roles WHERE rolname = 'policygraph_reader')
    ) THEN
        RAISE EXCEPTION 'policygraph_reader has an unexpected role membership';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'policygraph_reader')
    ) THEN
        RAISE EXCEPTION 'policygraph_reader unexpectedly owns database objects';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE companyx TO policygraph_reader;
GRANT USAGE ON SCHEMA public TO policygraph_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM policygraph_reader;
GRANT SELECT ON TABLE
    departments,
    employees,
    clients,
    products,
    contracts,
    projects,
    sales,
    support_tickets,
    document_chunks
TO policygraph_reader;
