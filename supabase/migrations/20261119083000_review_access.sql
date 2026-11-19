-- The broad dashboard grants run after the original review ACL. Keep the audited RPC as its sole writer.
REVOKE ALL ON TABLE public.agent_action_reviews FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.agent_action_reviews TO service_role;
REVOKE ALL ON SEQUENCE public.agent_action_reviews_id_seq FROM PUBLIC,anon,authenticated,service_role;
