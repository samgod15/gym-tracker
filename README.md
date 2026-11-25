# Gym Tracker

An iPhone home-screen app for logging weights, sets and reps, with PRs, progress charts, strength levels, calorie and protein targets, a rest timer, and bodyweight and body-measurement logs. It works offline. Cloud sync through Firebase is optional. Anyone you send the link to gets their own setup and their own data.

- **Logging:** total lbs, plates per side (with a plate picker), stack plates / pin #, per-dumbbell weight, bodyweight + added weight, and cardio (minutes / avg HR)
- **Set types:** warm-up, working and drop sets, supersets, and RIR for each set
- **First open:** a short setup (sex, age, weight, height, goal, activity) and a starter plan: Upper / Lower, Push / Pull / Legs, Full Body A / B, or empty. Each workout pre-fills with your numbers from last time.
- **Progress:** an estimated 1-rep max chart for each exercise, your PRs (best e1RM, heaviest set, most reps) and every past session
- **Rest timer:** starts on its own when you check off a set. It skips the rest between superset partners and before a drop set.
- **Strength level:** Beginner to Elite for bench, squat, deadlift, OHP, RDL, leg press, pulldown, pull-ups, DB press, curls and hip thrust, scaled to your sex and bodyweight from StrengthLevel.com averages.
- **Daily targets:** calories from Mifflin-St Jeor × activity, adjusted for your goal (lose fat, recomp, build muscle, maintain), plus protein, carbs and fat. After 2 weeks of weigh-ins it compares your real weekly rate with the goal and suggests an adjustment.
- **Body:** bodyweight with a 7-day average, tape measurements in cm or inches, and a US Navy body-fat estimate.
- **Your plan:** add your program as a PDF (or a photo or screenshot of it). It shows page by page on the Train tab and from the **Plan** button during a workout, works offline, and syncs to your account.
- **Plan → routines:** when the PDF has text, the app reads the workouts, exercises, sets, reps, supersets (A1/A2), rest and notes, matches them to your exercise library, and shows them for you to check before it creates the routines. Uploading a new plan replaces the routines made from the old one and keeps routines you built yourself. New users can pick **Use my own plan** during setup.

---

## 1. Put it online with GitHub Pages (≈5 min)

1. Go to github.com and sign in (or create a free account). Tap **+ → New repository**, name it `gym-tracker`, choose **Public**, then **Create repository**.
   GitHub Pages is free only for public repos. Only the app's code is public. Your workouts stay on your phone and in your own Firebase account.
2. On the new repo page, click **"uploading an existing file"**. Drag in **everything inside** the unzipped `gym-tracker` folder (`index.html`, `sw.js`, `manifest.webmanifest`, `firestore.rules`, and the `css`, `js` and `icons` folders), not the folder itself. Click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment → Source*, pick **Deploy from a branch**, set the branch to **main** and the folder to **/(root)**, then click **Save**.
4. After a minute or two the site will be live at `https://YOUR-USERNAME.github.io/gym-tracker/`. The Pages screen shows this link.

## 2. Install it on your iPhone

1. Open that link in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. From then on, always open it **from the icon**. On iOS, the Home Screen app keeps its own storage, separate from a Safari tab.

## 3. Turn on cloud sync with Firebase (≈10 min, free)

1. Go to **console.firebase.google.com → Create a project**. Name it `gym-tracker` and turn Google Analytics off.
2. **Sign-in:** go to **Build → Authentication → Get started → Sign-in method**, turn on **Email/Password** and save.
   Then go to **Authentication → Settings → Authorized domains → Add domain** and add `YOUR-USERNAME.github.io`.
3. **Database:** go to **Databases & Storage → Firestore → Create database**. Pick a location near you (it can't be changed later), choose **Production mode**, then **Create**.
   Open the **Rules** tab, replace everything with the contents of `firestore.rules` from this folder, and tap **Publish**. These rules let each account read and write only its own data.
4. **Config:** open **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register an app called `gym-tracker` and skip Firebase Hosting. Firebase then shows a `firebaseConfig = { … }` block; copy those values.
5. On GitHub, open `js/firebase-config.js`, tap the ✏️ (edit) button, paste in your values (apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId) and **Commit changes**.
6. Wait a minute for Pages to update. Then fully close the app (swipe it away) and reopen it **twice**: the first launch downloads the update and the second one uses it.
7. In the app, go to **Settings → Cloud sync**, enter your email and a password, and tap **Create account**. On a new phone, use **Sign in** and everything comes back.

> The values in `firebase-config.js` aren't secret. Every Firebase web app ships them to the browser. Your data is protected by the rules from step 3.

## Using it

| What you want | How |
|---|---|
| Log a set | Tap **✓**. If you leave reps blank, it uses last session's reps for that set. |
| Warm-up / drop set type | Tap the set number (1, 2, W, D) |
| Add a set, warm-up or drop set | **+ Set**, **+ Warm-up** or **+ Drop** under the exercise |
| Delete a set | Swipe the set left, or tap **− Set** to remove the last one. **Undo** appears for 5 seconds. |
| Remove an exercise from today's workout | The 🗑 next to its name (Undo appears) |
| Add or view your plan PDF | **Train → Add plan**. During a workout, tap **Plan**. |
| Turn the plan into routines | Happens after upload. To redo it: **Train → Your plan → Update**. Tap an exercise in the review to change what it's matched to. |
| Superset, rest time, reorder, swap or remove an exercise | Tap the exercise name (⋯) |
| Plate-loaded machines | Tap the load box, then tap plates for **one side**. Set the empty bar or sled weight under Progress → exercise → **Edit**. |
| Stack machines without lb markings | Enter the plate or pin number. To chart in lbs, set **lbs per plate** in Edit. |
| Edit the routines | **Train → ✎** next to a routine |
| Back up without sync | **Settings → Export** saves a file to Files or iCloud Drive. **Import** merges a file back in. |

Estimated 1-rep max uses the Epley formula on working sets of 15 reps or fewer. Warm-ups and drop sets never count toward PRs or charts.

## Known limits

- **No rest alert while the phone is locked.** iPhone web apps can't schedule local notifications. The app keeps the screen awake during a workout (needs iOS 18.4 or later), flashes the timer green and beeps. The beep doesn't play when the phone is on silent.
- **Deleting the Home Screen icon can delete the local data.** That's why sync and backups exist.
- **Reading routines needs a PDF with real text.** Scans and photos can be viewed but not read into routines (there's no text in them to read). Plans laid out as lists ("Bench press 3 x 8–10") or tables (Exercise / Sets / Reps) read best; a multi-week plan uses the first week's version of each day.
- **Plan files up to 10 MB and 40 pages.** Sync stores the file in Firestore in 700 KB pieces, because Cloud Storage for Firebase now needs the paid Blaze plan. Firestore's free tier (1 GiB) is shared by everyone who signs in to your Firebase project.
- The starter routines are starting points. Edit them to match your own plan.
- Strength levels, calorie targets and body fat are estimates. Strength standards for machines vary with the machine, so leg press and pulldown levels are rough. Let your weekly weight trend decide calories.

## Updating the app later

Upload the changed files to the same GitHub repo. If you change anything besides `firebase-config.js`, also bump `CACHE` at the top of `sw.js` (for example `gym-tracker-v1.0.1`). The app then shows **Update ready → Reload**, and it never reloads by itself in the middle of a workout.

## Files

```
index.html               app shell
css/app.css              styles and the four themes
js/app.js                screens and logic
js/calc.js               load math, e1RM, PRs, superset/rest rules
js/body.js               strength standards, calorie targets, body fat
js/db.js                 on-phone storage (IndexedDB), export/import
js/sync.js               Firebase sync (newest edit wins, deletes sync too)
js/seed.js               exercise library and starter plans
js/timer.js              rest timer, wake lock, beep
js/charts.js             progress charts
js/fx.js                 moving backgrounds and themes
js/install.js            Add to Home Screen help
js/plan.js               plan PDF/photo: import, page rendering, storage
js/planparse.js          reads workouts, sets and reps out of a plan's text
js/vendor/pdfjs/         pdf.js 6.2 (Mozilla, Apache-2.0) for showing PDFs
js/firebase-config.js    ← paste your Firebase config here
sw.js                    offline support
firestore.rules          paste into Firestore → Rules
```
