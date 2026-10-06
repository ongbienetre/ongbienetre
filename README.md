# 🌿 ONG Bien-Être — Site officiel

ongbienetre/ongbienetre est un dépôt spécial. Ce dépôt contient le site web complet de l'ONG Bien-Être, incluant le frontend public et le backend d'adhésion. Le projet vise à promouvoir les actions de l'ONG et faciliter l'inscription des membres en ligne.

🔗 **Site en ligne** : [https://ongbienetre.org](https://ongbien-etre.org/) 

---

## 📁 Structure du projet
ONG-BienEtre-site/ ├── backend/              
# Serveur Node.js Express (API + génération PDF + envoi email) ├── index.html            
# Page d'accueil ├── about-more/           # Page "À propos" ├── membership-more/      
# Page d'adhésion ├── reinsertion-more/     # Page réinsertion ├── images/               
# Ressources visuelles ├── .env.example          
# Variables d'environnement (sans secrets) ├── .gitignore            
# Fichiers à exclure du dépôt

---

## 🚀 Fonctionnalités

- 📄 Génération automatique de PDF d'adhésion
- 📧 Envoi d'email de confirmation via Gmail
- 🧾 Attribution d’un numéro unique à chaque membre
- 🔗 Intégration avec une plateforme de paiement
- 🖼️ Site vitrine responsive et accessible

---

## 🛠️ Technologies utilisées

- **Frontend** : HTML, CSS, JavaScript
- **Backend** : Node.js, Express, PDFKit, Nodemailer
- **Hébergement** : GitHub + Render (backend)

---

## ⚙️ Configuration du backend

1. Crée un fichier `.env` dans `/backend` :

```env
EMAIL_USER=ongbienetre349@gmail.com
EMAIL_PASS=mot_de_passe_application
📦 Déploiement
- Le backend est déployé sur Render
- Le frontend peut être hébergé sur GitHub Pages ou Vercel

📄 Licence
Projet développé pour l’ONG Bien-Être. Usage privé ou institutionnel uniquement.

🤝 Contributeurs
- Moctar OUATTARA — Fondateur & Directeur de "LA MAISON DG" ( Social Media Marketing Agency). Site : https://lamaisondg.github.io/agency/
Architecte du projet, branding, développement technique

