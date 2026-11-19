import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, SafeAreaView, ScrollView, StatusBar, StyleSheet,
  Text, TextInput, TouchableOpacity as TO, View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Router, genCodes, toCsv, fmtDur, fmtBytes } from './src/ros';

const C = { paper: '#F3EEE3', card: '#FFFBF2', ink: '#1C1A17', mute: '#7A7467', line: '#DDD5C3', acc: '#C2410C' };
const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

const Btn = ({ t, onPress, off, ghost }) => (
  <TO onPress={onPress} disabled={off} style={[s.btn, ghost && s.ghost, off && { opacity: 0.4 }]}>
    <Text style={[s.btnT, ghost && { color: C.ink }]}>{t}</Text>
  </TO>
);
const Field = ({ label, ...p }) => (
  <View style={{ flex: 1, marginBottom: 12 }}>
    <Text style={s.lab}>{label}</Text>
    <TextInput placeholderTextColor={C.mute} autoCapitalize="none" autoCorrect={false} style={s.inp} {...p} />
  </View>
);

const meta = (p) => [
  p.duration && `Durée ${fmtDur(p.duration)}`,
  p.validity && `Validité ${fmtDur(p.validity)}`,
  ...p.limits.map((l) => [
    l.name, l.rate, l.transfer && fmtBytes(l.transfer),
    l.from !== '00:00:00' || l.till !== '23:59:59' ? `${l.from}–${l.till}` : '',
  ].filter(Boolean).join(' · ')),
].filter(Boolean);

export default function App() {
  const [cfg, setCfg] = useState({ host: '', user: 'admin', pass: '' });
  const [r, setR] = useState(null);
  const [plans, setPlans] = useState([]);
  const [warn, setWarn] = useState('');
  const [tab, setTab] = useState('gen');
  const [pre, setPre] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function connect(c) {
    setBusy(true); setErr('');
    try {
      const rt = new Router(c);
      const st = await rt.settings();
      const p = await rt.loadPlans();
      await SecureStore.setItemAsync('cfg', JSON.stringify(c));
      setWarn(st.enabled !== 'true' ? 'User Manager est désactivé sur le routeur.'
        : st['use-profiles'] !== 'true' ? 'use-profiles=no : les profils ne seront pas appliqués.' : '');
      setPlans(p); setR(rt);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  useEffect(() => {
    SecureStore.getItemAsync('cfg').then((v) => { if (v) { const c = JSON.parse(v); setCfg(c); connect(c); } }).catch(() => {});
  }, []);
  const logout = async () => { await SecureStore.deleteItemAsync('cfg'); setR(null); };

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="dark-content" />
      <View style={s.head}>
        <Text style={s.brand}>SALAM-WIFI</Text>
        {r && (
          <View style={s.row}>
            <TO onPress={() => connect(cfg)}><Text style={s.link}>Actualiser</Text></TO>
            <TO onPress={logout}><Text style={s.link}>Quitter</Text></TO>
          </View>
        )}
      </View>

      {!r ? (
        <ScrollView contentContainerStyle={s.pad}>
          <Text style={s.h1}>Connexion au routeur</Text>
          <Text style={s.sub}>API REST RouterOS 7 (service www).</Text>
          <Field label="Adresse" value={cfg.host} placeholder="192.168.88.1 ou http://IP:8080"
            onChangeText={(host) => setCfg({ ...cfg, host })} />
          <View style={s.row}>
            <Field label="Utilisateur" value={cfg.user} onChangeText={(user) => setCfg({ ...cfg, user })} />
            <Field label="Mot de passe" value={cfg.pass} secureTextEntry onChangeText={(pass) => setCfg({ ...cfg, pass })} />
          </View>
          {!!err && <Text style={s.err}>{err}</Text>}
          <Btn t={busy ? 'Connexion…' : 'Se connecter'} off={busy} onPress={() => connect(cfg)} />
        </ScrollView>
      ) : (
        <>
          <View style={{ flex: 1, display: tab === 'gen' ? 'flex' : 'none' }}>
            <Generate r={r} plans={plans} warn={warn} onDone={(c) => { setPre(c); setTab('exp'); }} />
          </View>
          {tab === 'exp' && <Exporter r={r} plans={plans} pre={pre} />}
          <View style={s.tabs}>
            {[['gen', 'Générer'], ['exp', 'Exportation']].map(([k, l]) => (
              <TO key={k} style={[s.tab, tab === k && s.tabOn]} onPress={() => setTab(k)}>
                <Text style={[s.tabT, tab === k && { color: C.acc }]}>{l}</Text>
              </TO>
            ))}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

function Generate({ r, plans, warn, onDone }) {
  const [sel, setSel] = useState([]); // ordre = ordre d'attribution
  const [f, setF] = useState({
    qty: '10', prefix: 'WIFI', digits: '4',
    comment: `Lot ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  });
  const [same, setSame] = useState(true);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(0);
  const set = (k) => (v) => setF({ ...f, [k]: v });
  const toggle = (n) => setSel(sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]);
  const move = (i, d) => { const a = [...sel]; [a[i], a[i + d]] = [a[i + d], a[i]]; setSel(a); };
  const list = [...sel.map((n) => plans.find((p) => p.name === n)).filter(Boolean), ...plans.filter((p) => !sel.includes(p.name))];

  async function go() {
    const n = +f.qty, d = +f.digits, c = f.comment.trim();
    if (!sel.length) return Alert.alert('Profil requis', 'Choisissez au moins un profil.');
    if (!(n > 0 && n <= 1000)) return Alert.alert('Quantité', 'Entre 1 et 1000 tickets.');
    if (!(d >= 3 && d <= 10)) return Alert.alert('Chiffres', 'Entre 3 et 10 chiffres.');
    if (!c) return Alert.alert('Commentaire', 'Saisissez un commentaire de lot.');
    setBusy(true); setProg(0);
    try {
      const users = await r.get('/user-manager/user?.proplist=name,comment');
      if (users.some((u) => u.comment === c)) throw new Error('Ce commentaire existe déjà : choisissez-en un autre.');
      const codes = genCodes({ qty: n, prefix: f.prefix.trim(), digits: d, same, taken: new Set(users.map((u) => u.name)) });
      const res = await r.createBatch(codes, sel, c, setProg);
      if (!res.ok) throw new Error(`Aucun ticket créé. ${res.last}`);
      if (res.fail) Alert.alert('Terminé avec erreurs', `${res.ok} créés, ${res.fail} échecs : ${res.last}`);
      onDone(c);
    } catch (e) { Alert.alert('Erreur', e.message); }
    setBusy(false);
  }

  return (
    <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      {!!warn && <Text style={s.warnBox}>{warn}</Text>}
      <Text style={s.h1}>Profils</Text>
      <Text style={s.sub}>Touchez pour attribuer. Le numéro indique l’ordre : le profil 1 est actif en premier, puis le suivant prend le relais.</Text>
      {list.map((p) => {
        const i = sel.indexOf(p.name), on = i >= 0;
        return (
          <TO key={p.name} onPress={() => toggle(p.name)} style={[s.card, on && s.cardOn]}>
            <View style={s.row}>
              <View style={[s.badge, on && s.badgeOn]}>
                <Text style={[s.badgeT, on && { color: '#fff' }]}>{on ? i + 1 : ''}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{p.name}</Text>
                {meta(p).map((m, k) => <Text key={k} style={s.meta}>{m}</Text>)}
                {p.startsWhen === 'assigned' && p.validity > 0 && <Text style={s.warn}>Démarre dès la création du ticket</Text>}
              </View>
              {on && sel.length > 1 && (
                <View>
                  <TO disabled={i === 0} onPress={() => move(i, -1)} style={[s.mv, i === 0 && { opacity: 0.25 }]}><Text>▲</Text></TO>
                  <TO disabled={i === sel.length - 1} onPress={() => move(i, 1)} style={[s.mv, i === sel.length - 1 && { opacity: 0.25 }]}><Text>▼</Text></TO>
                </View>
              )}
            </View>
          </TO>
        );
      })}
      {!plans.length && <Text style={s.sub}>Aucun profil trouvé sur le routeur.</Text>}

      <Text style={[s.h1, { marginTop: 20 }]}>Tickets</Text>
      <View style={s.row}>
        <Field label="Quantité" value={f.qty} keyboardType="number-pad" onChangeText={set('qty')} />
        <Field label="Préfixe" value={f.prefix} onChangeText={set('prefix')} />
        <Field label="Chiffres" value={f.digits} keyboardType="number-pad" onChangeText={set('digits')} />
      </View>
      <TO onPress={() => setSame(!same)} style={{ marginBottom: 12 }}>
        <Text style={s.meta}>Mot de passe : {same ? 'identique au code' : 'aléatoire (6 chiffres)'}  ·  toucher pour changer</Text>
      </TO>
      <Field label="Commentaire du lot" value={f.comment} onChangeText={set('comment')} />
      <Btn t={busy ? `Création… ${Math.round(prog * 100)} %` : `Générer ${f.qty || 0} tickets`} off={busy} onPress={go} />
    </ScrollView>
  );
}

function Exporter({ r, plans, pre }) {
  const [gs, setGs] = useState(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState(pre ? [pre] : []);
  useEffect(() => { r.loadBatches().then(setGs).catch((e) => setErr(e.message)); }, []);
  const toggle = (c) => setPick(pick.includes(c) ? pick.filter((x) => x !== c) : [...pick, c]);

  async function exp() {
    try {
      const chosen = gs.filter((g) => pick.includes(g.comment));
      const rows = chosen.flatMap((g) => g.rows);
      if (rows.some((x) => !x.password))
        return Alert.alert('Mots de passe indisponibles', 'Le routeur ne les renvoie pas : utilisez un compte avec la politique « sensitive ».');
      const name = (chosen.length === 1 ? chosen[0].comment : `tickets_${new Date().toISOString().slice(0, 10)}`)
        .replace(/[\\/:*?"<>|]/g, '_') + '.csv';
      const uri = FileSystem.cacheDirectory + name;
      await FileSystem.writeAsStringAsync(uri, toCsv(rows, plans), { encoding: FileSystem.EncodingType.UTF8 });
      await Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle: name });
    } catch (e) { Alert.alert('Erreur', e.message); }
  }

  if (err) return <Text style={[s.err, s.pad]}>{err}</Text>;
  if (!gs) return <ActivityIndicator style={{ marginTop: 40 }} color={C.acc} />;
  const total = gs.filter((g) => pick.includes(g.comment)).reduce((n, g) => n + g.rows.length, 0);
  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.pad}>
        <Text style={s.h1}>Lots</Text>
        <Text style={s.sub}>Les tickets sont regroupés par commentaire.</Text>
        {gs.map((g) => {
          const on = pick.includes(g.comment);
          const chains = [...new Set(g.rows.map((x) => x.profiles.join(' → ') || '—'))].join(' · ');
          return (
            <TO key={g.comment} onPress={() => toggle(g.comment)} style={[s.card, on && s.cardOn]}>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{g.comment}</Text>
                  <Text style={s.meta}>{g.rows.length} tickets · {chains}</Text>
                </View>
                <View style={[s.badge, on && s.badgeOn]}><Text style={{ color: '#fff' }}>{on ? '✓' : ''}</Text></View>
              </View>
            </TO>
          );
        })}
        {!gs.length && <Text style={s.sub}>Aucun ticket sur le routeur.</Text>}
      </ScrollView>
      <View style={s.foot}>
        <Btn t={pick.length ? `Exporter en CSV (${total} tickets)` : 'Sélectionnez un lot'} off={!pick.length} onPress={exp} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper, paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderColor: C.line },
  brand: { fontSize: 18, fontWeight: '800', letterSpacing: 1.5, color: C.ink },
  link: { color: C.acc, fontWeight: '600' },
  pad: { padding: 20, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  h1: { fontSize: 22, fontWeight: '700', color: C.ink, marginBottom: 4 },
  sub: { color: C.mute, marginBottom: 14, lineHeight: 19 },
  lab: { color: C.mute, fontSize: 12, marginBottom: 4 },
  inp: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 11, fontSize: 16, color: C.ink },
  btn: { backgroundColor: C.ink, borderRadius: 10, padding: 15, alignItems: 'center' },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: C.ink },
  btnT: { color: C.paper, fontWeight: '700', fontSize: 16 },
  err: { color: '#B91C1C', marginBottom: 12 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderStyle: 'dashed', borderRadius: 10, padding: 14, marginBottom: 10 },
  cardOn: { borderColor: C.acc, borderStyle: 'solid', borderWidth: 2 },
  badge: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  badgeOn: { backgroundColor: C.acc, borderColor: C.acc },
  badgeT: { fontFamily: mono, fontWeight: '700', color: C.mute },
  name: { fontSize: 17, fontWeight: '700', color: C.ink, fontFamily: mono },
  meta: { color: C.mute, fontSize: 13, marginTop: 2 },
  warn: { color: C.acc, fontSize: 12, marginTop: 4 },
  warnBox: { backgroundColor: '#FDE7D7', color: '#7C2D12', padding: 12, borderRadius: 8, marginBottom: 14 },
  mv: { padding: 8 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.card },
  tab: { flex: 1, padding: 16, alignItems: 'center' },
  tabOn: { borderTopWidth: 2, borderColor: C.acc, marginTop: -1 },
  tabT: { fontWeight: '700', color: C.mute },
  foot: { padding: 16, borderTopWidth: 1, borderColor: C.line },
});
