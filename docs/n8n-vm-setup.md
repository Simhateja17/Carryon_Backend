# n8n Setup on a VM (Production-Ready)

This guide explains how to run n8n on a Linux VM using Docker Compose, Nginx, and HTTPS.

## 1. Architecture

- n8n runs in Docker on port 5678
- Nginx acts as reverse proxy on ports 80/443
- Let's Encrypt provides TLS certificates
- Persistent workflow data is stored in a Docker volume

## 2. Prerequisites

- Ubuntu 22.04 or 24.04 VM (recommended)
- Minimum: 2 vCPU, 2 GB RAM, 20 GB disk
- A domain/subdomain (example: `n8n.example.com`) pointed to VM public IP
- Firewall/security group allows inbound:
  - TCP 22 (SSH)
  - TCP 80 (HTTP)
  - TCP 443 (HTTPS)

## 3. Install Docker

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and log back in so Docker group permissions apply.

## 4. Create n8n Docker Compose setup

```bash
mkdir -p ~/n8n
cd ~/n8n
```

Create `.env`:

```bash
cat > .env << 'EOF'
N8N_HOST=n8n.example.com
N8N_PROTOCOL=https
GENERIC_TIMEZONE=Asia/Kolkata
N8N_ENCRYPTION_KEY=replace_with_a_long_random_secret
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=replace_with_strong_password
EOF
```

Create `docker-compose.yml`:

```bash
cat > docker-compose.yml << 'EOF'
services:
  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:5678:5678"
    env_file:
      - .env
    environment:
      - N8N_PORT=5678
      - WEBHOOK_URL=https://${N8N_HOST}/
      - N8N_BASIC_AUTH_ACTIVE=true
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:
EOF
```

Start n8n:

```bash
docker compose up -d
docker compose ps
```

## 5. Install and configure Nginx

```bash
sudo apt install -y nginx
```

Create Nginx config:

```bash
sudo tee /etc/nginx/sites-available/n8n >/dev/null << 'EOF'
server {
  listen 80;
  server_name n8n.example.com;

  location / {
    proxy_pass http://127.0.0.1:5678;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600;
    proxy_send_timeout 3600;
  }
}
EOF
```

Enable site and verify config:

```bash
sudo ln -s /etc/nginx/sites-available/n8n /etc/nginx/sites-enabled/n8n
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Enable HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d n8n.example.com
```

Test certificate auto-renewal:

```bash
sudo certbot renew --dry-run
```

## 7. Verification checklist

- Open `https://n8n.example.com`
- Owner account page loads
- Create and run a test workflow
- Test webhook trigger from external source

## 8. Operations

### View logs

```bash
cd ~/n8n
docker compose logs -f n8n
```

### Restart service

```bash
cd ~/n8n
docker compose restart n8n
```

### Update n8n safely

```bash
cd ~/n8n
docker compose pull
docker compose up -d
docker image prune -f
```

### Backup workflow data

```bash
mkdir -p ~/backups

docker run --rm \
  -v n8n_n8n_data:/volume \
  -v "$HOME/backups":/backup \
  alpine \
  tar czf /backup/n8n-data-$(date +%F).tar.gz -C /volume .
```

## 9. Recommended hardening

- Keep `5678` bound to localhost only (`127.0.0.1:5678:5678`)
- Use strong values for:
  - `N8N_ENCRYPTION_KEY`
  - `N8N_BASIC_AUTH_PASSWORD`
- Restrict SSH access (disable password auth, use keys)
- Enable VM automatic security updates
- Backup n8n volume daily

## 10. Troubleshooting

### n8n not reachable via domain

- Check DNS record points to VM public IP
- Check firewall/security group allows 80 and 443
- Check Nginx status:

```bash
sudo systemctl status nginx
sudo nginx -t
```

### n8n container not running

```bash
cd ~/n8n
docker compose ps
docker compose logs --tail=200 n8n
```

### Webhooks use wrong URL

- Ensure these values are set correctly in `.env` and container env:
  - `N8N_HOST`
  - `N8N_PROTOCOL=https`
  - `WEBHOOK_URL=https://<your-domain>/`

## 11. Optional: PostgreSQL instead of SQLite

By default, the setup above uses SQLite in the n8n volume. For higher scale and reliability, migrate to PostgreSQL using Docker Compose with a dedicated `postgres` service.

---

Owner: Backend/DevOps  
Last updated: 2026-04-11
