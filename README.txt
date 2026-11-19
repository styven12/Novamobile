SALAM-WIFI UM : tickets User Manager (RouterOS 7.24) -> CSV

Routeur (une seule fois)
  /ip service set www disabled=no                  (l'app utilise l'API REST)
  /user-manager set enabled=yes use-profiles=yes
  /user-manager router add name=local address=127.0.0.1 shared-secret=XXXX
  /radius add service=hotspot address=127.0.0.1 secret=XXXX
  /ip hotspot profile set [find] use-radius=yes
  Le compte utilise doit avoir les politiques read, write, sensitive.
  Package "user-manager" installe (extra packages).

Lancer
  npm install
  npx expo install --fix     (si des versions different)
  npx expo start             (Expo Go, telephone et routeur sur le meme reseau)

Fonctions
  1. Generation de tickets User Manager (user + user-profile)
  2. Export CSV : code,password,profile,duration (UTF-8 BOM, CRLF)
  3. Profils lus dans profile-limitation, attribution multiple ordonnee
  4. Onglet Exportation : lots regroupes par commentaire
