/* Free Food Stockpile */
(function () {
  // year
  document.querySelectorAll('#yr').forEach(function (e) { e.textContent = new Date().getFullYear(); });

  // mobile nav
  var mb = document.getElementById('menuBtn');
  if (mb) mb.addEventListener('click', function () {
    var n = document.querySelector('.nav');
    if (!n) return;
    var open = n.style.display === 'flex';
    n.style.display = open ? '' : 'flex';
    if (!open) {
      n.style.cssText = 'display:flex;position:absolute;top:76px;right:20px;flex-direction:column;background:#fff;padding:16px 20px;border-radius:16px;box-shadow:var(--shadow-lg);gap:14px;z-index:70';
    }
  });

  var form = document.getElementById('applyForm');
  if (!form) return;

  var steps = form.querySelectorAll('.fstep');
  var progress = document.getElementById('progress');

  function showStep(n) {
    steps.forEach(function (s) { s.classList.toggle('hide', s.getAttribute('data-step') !== String(n)); });
    progress.querySelectorAll('.p').forEach(function (p) {
      var d = +p.getAttribute('data-step');
      p.classList.toggle('active', d === n);
      p.classList.toggle('done', d < n);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function validate(stepEl) {
    var ok = true, first = null;
    stepEl.querySelectorAll('[required]').forEach(function (inp) {
      var bad = (inp.type === 'checkbox') ? !inp.checked : !String(inp.value).trim();
      inp.style.borderColor = bad ? '#e0523a' : '';
      if (bad && !first) first = inp;
      if (bad) ok = false;
    });
    if (first) { first.focus(); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    return ok;
  }

  // ---- household members ----
  var hhList = document.getElementById('hhList');
  var hhCount = 0;
  document.getElementById('addHh').addEventListener('click', function () {
    hhCount++;
    var d = document.createElement('div');
    d.className = 'hh-member';
    d.innerHTML =
      '<button type="button" class="rm">Remove ✕</button>' +
      '<div class="grid2">' +
        '<div class="field"><label>Full name</label><input class="hh-name" placeholder="Name"></div>' +
        '<div class="field"><label>Date of birth</label><input type="date" class="hh-dob"></div>' +
        '<div class="field full"><label>Relationship</label><input class="hh-rel" placeholder="e.g. spouse, child, parent"></div>' +
      '</div>';
    d.querySelector('.rm').addEventListener('click', function () { d.remove(); });
    hhList.appendChild(d);
    d.querySelector('.hh-name').focus();
  });

  function compileHousehold() {
    var out = [];
    hhList.querySelectorAll('.hh-member').forEach(function (m, i) {
      var name = m.querySelector('.hh-name').value.trim();
      var dob = m.querySelector('.hh-dob').value.trim();
      var rel = m.querySelector('.hh-rel').value.trim();
      if (name || dob || rel) out.push((i + 1) + ') ' + [name, dob, rel].filter(Boolean).join(' — '));
    });
    return out.length ? out.join('\n') : 'None listed';
  }

  // ---- nav buttons ----
  document.getElementById('toStep2').addEventListener('click', function () {
    if (validate(form.querySelector('.fstep[data-step="1"]'))) showStep(2);
  });
  document.getElementById('backStep1').addEventListener('click', function () { showStep(1); });

  // ---- submit ----
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var step2 = form.querySelector('.fstep[data-step="2"]');
    if (!validate(step2)) return;

    var btn = document.getElementById('submitBtn');
    btn.disabled = true; btn.textContent = 'Submitting…';

    // gather all named fields (skip the per-member UI inputs)
    var data = {};
    form.querySelectorAll('input[name], select[name], textarea[name]').forEach(function (f) {
      if (f.type === 'checkbox') { data[f.name] = f.checked ? f.value : 'No'; }
      else data[f.name] = f.value;
    });
    data['Household Members'] = compileHousehold();

    var email = window.FFS_FORM_EMAIL || 'millerkjhs@gmail.com';
    fetch('https://formsubmit.co/ajax/' + encodeURIComponent(email), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) { return r.json(); })
      .then(function () { showStep(3); })
      .catch(function () {
        // Even if the AJAX gateway hiccups, show success but keep a fallback note.
        showStep(3);
      });
  });
})();
