# Deploy Process

This directory is intended to be used as a standalone repository named `editask-web`.

## 1. Create the Repository

Create a new GitHub repository:

```text
editask-web
```

If you use a different repository name, update `base` in `vite.config.ts`.

## 2. Prepare Local Git

Run these commands inside this `editask-web` directory:

```powershell
git init
git branch -M main
git add .
git commit -m "Initial editask web app"
git remote add origin https://github.com/{your-user}/editask-web.git
git push -u origin main
```

## 3. Configure GitHub Pages

Open the GitHub repository settings:

```text
Settings -> Pages
```

Set:

```text
Source: GitHub Actions
```

The included workflow `.github/workflows/deploy.yml` builds the app and deploys `dist` to GitHub Pages.

## 4. Configure Firebase Variables

Open:

```text
Settings -> Secrets and variables -> Actions -> Variables
```

Add these repository variables from your Firebase Web app config:

```text
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
```

The Firebase Web API key is public client configuration. Firestore Security Rules and Google Authentication control access.

## 5. Configure Firebase Console

In Firebase Console, add the GitHub Pages domain to Authentication authorized domains:

```text
{your-user}.github.io
```

Also confirm:

```text
Authentication -> Sign-in method -> Google: enabled
Firestore Database: created
Firestore Rules: set from firestore.rules
```

## 6. Deploy

Push to `main`:

```powershell
git push
```

Then open:

```text
https://{your-user}.github.io/editask-web/
```

The first deployment may take a few minutes.

## 7. Local Development

Install dependencies:

```powershell
npm install
Copy-Item .env.example .env.local
```

Fill `.env.local` with the same Firebase Web app config.

Start the dev server:

```powershell
npm run dev
```

Open the local URL shown by Vite. With the default base path, it is usually:

```text
http://localhost:5173/editask-web/
```

## 8. Manual Build Check

Before pushing, you can check the production build:

```powershell
npm run build
```
