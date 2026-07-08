# phase6-teardown (staged /etc edits — #64)

Staged-not-applied artifacts for retiring the nginx/oauth2-proxy gate. `APPLY_RUNBOOK.md`
is the only file: the live `/etc/nginx/sites-available/princess-pi.dev` was hand-edited on
the VPS and is not mirrored in this repo, so the runbook locates the dead blocks by grep
instead of shipping a blind replacement file. WHY: a staged config written without reading
the live file would risk clobbering unrelated vhost edits at apply time.
