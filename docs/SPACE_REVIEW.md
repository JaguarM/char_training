# Space-placement review list (2026-07-06)

> **Status 2026-07-12: superseded.** These disputes came from the grid-path
> era, where spaces were inferred from the measureText model. The blind
> reader (2026-07-10, [BLIND_READER.md](BLIND_READER.md)) MEASURES pen gaps
> and self-calibrates the space width, and inspection settled the disputed
> rows in the pixels' favor (v3.txt carried collapses like
> "customersusetheAmericanExpress…"). Kept as reference for which rows were
> historically contentious ("styled"/narrow-space rows, v3 P3–P6).

28 rows where the transcription's spacing disagrees with the page pixels but the
automatic correction could not be double-confirmed. Three lines per row:
  -  current v3.txt
  ?  what the geometric fit suggested (NOT trustworthy on its own)
  r  what the line reader read from the pixels (usually the right answer —
     but note its own quirks: it can merge/round narrow spaces, and it strips □).

Reader lines are the recommended fix in most cases. Known pixel-truths verified
by hand this session: P3 L22 draws 'acts of omissions' (original document typo —
'of', not 'or'); the 'Date: Aug 11,2013' pattern has the space before the day
number, none after the comma; 'Time: 6:18 AM' has a narrow (~2.8px) drawn space
before AM.

```
held for MANUAL review (reader disagrees with the correction):
P2 L21 (line 77) worst-residual=0
  - "> Arrives: Albuquerque, NM - ABQ"
  ? "> Arrives: Albuquerque, NM - ABQ"
  r "> Arrives: Albuquerque, NM -ABQ"
P2 L39 (line 95) worst-residual=-1
  - "> As a service to our customers, American Express has partnered with ="
  ? ">Asaserviceto …(unresolved)"
  r "> As a service to our customers, American Express has partnered with ="
P2 L44 (line 100) worst-residual=0.42
  - "to access the online services of VisaCentral ="
  ? "toaccesstheonlineservicesof VisaCentral="
  r "to access the online services of VisaCentral ="
P2 L50 (line 106) worst-residual=0.63
  - "about our e-mail practices, please review the American Express Privacy ="
  ? "aboutoure-mailp ractices,p lease reviewtheAmericanExpressPrivacy="
  r "about our e-mail practices, please review the American Express Privacy ="
P3 L17 (line 128) worst-residual=0
  - "> Liability Statement. American Express Travel Related Services ="
  ? ">LiabilityStatement.AmericanExpressTravelRelatedServices="
  r "> Liability Statement. American Express Travel Related Services ="
P3 L22 (line 133) worst-residual=0
  - "directly or indirectly, from (1) the acts or omissions of travel ="
  ? "directly or indirectly, from (1) the acts or omissions of travel ="
  r "directly or indirectly, from (1) the acts of omissions of travel ="
P3 L25 (line 136) worst-residual=0.06
  - "of equipment, or changes in fares, itineraries or schedules; or (2) acts ="
  ? "of equipment, or changes in fares, itineraries or schedules; or(2)acts="
  r "of equipment, or changes in fares, itineraries or schedules; or (2) acts ="
P3 L47 (line 158) worst-residual=0.18
  - "arrangements, including levels and types of compensation and incentives ="
  ? "arrangements,includingl evelsandtypesofcompensationandincentives="
  r "arrangements, including levels and types of compensation and incentives ="
P4 L35 (line 201) worst-residual=0.02
  - "font-size:medium;\">\"American Express Travel\" &lt;<a ="
  ? "font-size:medium;\">\"American Express Travel\" &lt;<a ="
  r "font-size:medium;\">\"American Express Travel\" &lt;<a="
P4 L37 (line 203) worst-residual=0
  - "</a>&gt;<br></span></div><div style=3D\"margin-top: 0px; ="
  ? "</a>&gt;<br></span></div><divstyle=3D\"margin-top:0px;="
  r "</a>&gt;<br></span></div><div style=3D\"margin-top: 0px; ="
P5 L0 (line 221) worst-residual=0
  - "messages. &nbsp;If you have any questions, please contact Centurion ="
  ? "messages. &nbsp;If you have any questions, please contact Centurion ="
  r "messages. &nbsp;If you have any questions, please contact Centurion="
P5 L8 (line 229) worst-residual=0
  - "</a><br><br>If airline ="
  ? "</a><br><br>If airline="
  r "</a><br><br>If airline ="
P5 L19 (line 240) worst-residual=0
  - "Class<br> &nbsp;&nbsp;Seats: 3B<br> &nbsp;&nbsp;Departs: Boston, MA - ="
  ? "Class<br> &nbsp;&nbsp;Seats: 3B<br> &nbsp;&nbsp;Departs: Boston, MA -="
  r "Class<br> &nbsp;&nbsp;Seats: 3B<br> &nbsp;&nbsp;Departs: Boston, MA - ="
P5 L20 (line 241) worst-residual=0
  - "BOS<br> &nbsp;&nbsp;Date: Aug 11,2013 ="
  ? "BOS<br> &nbsp;&nbsp;Date: Aug 11,2013 ="
  r "BOS<br> &nbsp;&nbsp;Date:Aug 11,2013 ="
P5 L27 (line 248) worst-residual=0
  - "Flight Information:<br> &nbsp;&nbsp;Reserved: UNITED AIRLINES 3468<br> ="
  ? "FlightInformation:<br>&nbsp;&nbsp;Reserved:UNITEDA IRLINES3468<br>="
  r "Flight Information:<br> &nbsp;&nbsp;Reserved: UNITED AIRLINES 3468<br>="
P5 L29 (line 250) worst-residual=0
  - "ERATED BY &nbsp;/SHUTTLE AMERICA DBA UNITED EXPRESS<br> ="
  ? "ERATED BY&nbsp;/SHUTTLEAMERICADBAUNITEDEXPRESS<br>="
  r "ERATED BY &nbsp;/SHUTTLE AMERICA DBA UNITED EXPRESS<br> ="
P5 L35 (line 256) worst-residual=0
  - "&nbsp;&nbsp;Arrives: Albuquerque, NM - ABQ<br> &nbsp;&nbsp;Date: Aug ="
  ? "&nbsp;&nbsp;Arrives: Albuquerque, NM - ABQ<br> &nbsp;&nbsp;Date: Aug ="
  r "&nbsp;&nbsp;Arrives: Albuquerque, NM -ABQ<br> &nbsp;&nbsp;Date: Aug ="
P5 L38 (line 259) worst-residual=0
  - "bsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Time: 11:51 AM<br><br> Flight ="
  ? "bsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Time: 11:51 AM<br><br>Flight="
  r "bsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Time: 11:51 AM<br><br> Flight ="
P5 L41 (line 262) worst-residual=0
  - "ERATED BY &nbsp;/SKYWEST DBA UNITED EXPRESS<br> &nbsp;&nbsp;Class: First ="
  ? "ERATED BY&nbsp;/SKYWESTDBAUNITEDEXPRESS<br>&nbsp;&nbsp;Class:Fir st="
  r "ERATED BY &nbsp;/SKYWEST DBA UNITED EXPRESS<br> &nbsp;&nbsp;Class: First ="
P5 L43 (line 264) worst-residual=0.22
  - "- ABQ<br> &nbsp;&nbsp;Date: Aug 13,2013 ="
  ? "-ABQ<br>&nbsp;&nbsp;Date:Aug13,2013="
  r "-ABQ<br> &nbsp;&nbsp;Date:Aug 13,2013 ="
P5 L46 (line 267) worst-residual=0.71
  - "&nbsp;&nbsp;Arrives: San Francisco, CA - SFO<br> &nbsp;&nbsp;Date: Aug ="
  ? "&nbsp;&nbsp;Arrives: SanFrancisco,CA-SFO<br>&nbsp;&nbsp;Date:Aug="
  r "&nbsp;&nbsp;Arrives: San Francisco, CA -  SFO<br> &nbsp;&nbsp;Date: Aug ="
P5 L52 (line 273) worst-residual=0.09
  - "6CMY<br><br>NEED PASSPORT OR VISA SERVICES?<br><br> As a service to our ="
  ? "6CMY<br><br>NEED PASSPORT OR VISA SERVICES?<br><br>Asaserviceto our="
  r "6CMY<br><br>NEED PASSPORT OR VISA SERVICES?<br><br> As a service to our ="
P6 L3 (line 279) worst-residual=0.18
  - "services of VisaCentral and to receive discounted rates on travel ="
  ? "services ofVisaCentralandtore ceivediscountedrat esontravel="
  r "services of VisaCentral and to receive discounted rates on travel ="
P6 L9 (line 285) worst-residual=0
  - "<br><br>See attached itinerary ="
  ? "<br><br>Seeattacheditinerary="
  r "<br><br>See attached itinerary ="
P6 L14 (line 290) worst-residual=0
  - "<br><br><br><br>Thank ="
  ? "<br><br><br><br>Thank="
  r "<br><br>                                                                                       <br><br>Thank ="
P6 L25 (line 301) worst-residual=-1
  - "any loss, injury, expense or damage to persons or property resulting, ="
  ? "any loss, injuryexpenseo r damagetopersonsorpro…(unresolved)"
  r "any loss, injury, expense or damage to persons or property resulting, ="
P6 L29 (line 305) worst-residual=4
  - "of equipment, or changes in fares, itineraries or schedules; or (2) acts ="
  ? "of equipment, or changes infares,i tinerariesorschedules;or (2)act s ="
  r "of equipment, or changes in fares, itineraries or schedules; or (2) acts ="
P6 L50 (line 326) worst-residual=0.18
  - "arrangements, including levels and types of compensation and incentives ="
  ? "arrangements,includingl evelsandtypesofcompensationandincentives="
  r "arrangements, including levels and types of compensation and incentives ="

dry run — pass --write to apply the validated rows
```
