# Spec Draft: Resolve Duplicate Key NGINX Map Conflicts

## Goal
Resolve NGINX syntax reload errors caused by duplicate email entries in `/etc/nginx/serve-acls.map` when an email address is mapped to multiple client slugs.

## Detailed Plan

### 1. Merge Multiple Slugs
Modify `updateNginxAcls` in `extensions/lib/serve/nginx.js` to parse current mappings into a `Map<string, Set<string> | "all">` structure, and serialize them as space-separated strings, e.g.:
```nginx
"david@princess-pi.dev" "all";
"client@gmail.com" "princess-pi-packages/docs princess-pi-packages/research";
```

### 2. Update NGINX Server Location Block
Update `/etc/nginx/sites-available/princess-pi.dev` regex matching to allow space-separated match matching:
```nginx
    # Match allowed_client_slug contains client_slug wrapped in boundaries
    set $auth_status "deny";
    if ($allowed_client_slug = "all") {
        set $auth_status "allow";
    }
    if ($allowed_client_slug ~ "(^| )$client_slug($| )") {
        set $auth_status "allow";
    }
```

## Verification Plan
1. Launch multiple servers.
2. Verify that `/etc/nginx/serve-acls.map` merges duplicates correctly.
3. Reload NGINX successfully with no conflicts.
