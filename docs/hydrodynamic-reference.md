# Civilian hydrodynamic reference profile

## Scope

The optional civilian 6-DOF profile is a software-only BlueROV2 Heavy reference.
It makes numerical experiments dimensionally and dynamically more credible without
adding weapon-platform data. It is not a complete digital twin, manufacturer-certified
model, or field-qualified controller.

The archived high-speed portfolio demonstration remains available through the
`generic-fictional` profile and is not retroactively represented as physical data.

## Coefficient provenance

Mass, principal inertia, added-mass, linear damping, and quadratic damping are
transcribed from Table 4.1 of Patrick Ng's 2024 public MS thesis, *Marine Vehicle
Characterization and Nonlinear Model Predictive Control of a BlueROV2 Heavy*:

<https://bluerobotics.com/wp-content/uploads/2025/01/ng_patrick_ms_thesis_2024.pdf>

Manufacturer-published vehicle and T200 data provide the 11.5 kg mass, approximate
3-knot maximum speed, 9 kgf horizontal bollard thrust, and 14 kgf vertical bollard
thrust used to constrain the reference scenario:

- <https://docs.bluerobotics.com/downloads/>
- <https://bluerobotics.com/store/rov/bluerov2/>
- <https://bluerobotics.com/store/rov/bluerov2-accessories/brov2-heavy-kit/>

The simulator maps the source convention into `x = surge`, `y = heave`, and
`z = sway`. Direction-dependent rise/dive coefficients are averaged because the
current diagonal model stores one coefficient per axis.

| Quantity | Simulator value |
| --- | ---: |
| Mass | 11.5 kg |
| Net buoyancy | 6.675 N |
| Principal inertia | [0.8571, 1.0, 1.0] kg m² |
| Added mass, surge/heave/sway | [10.77, 28.525, 24.86] kg |
| Linear damping, surge/heave/sway | [38.95, 50.06, 60.11] N s/m |
| Quadratic damping, surge/heave/sway | [31.01, 95.275, 36.95] N s²/m² |
| Added angular inertia | [0.103, 0.120, 0.120] kg m² |
| Quadratic angular damping | [2.08, 2.42, 2.42] N m s²/rad² |

## Actuation approximation

The civilian profile uses a reduced vectored-thrust allocation: surge force,
vertical force, and yaw moment are independently bounded and passed through
first-order actuator lag. The horizontal and vertical force limits come from
published bollard-thrust figures. Yaw moment is a documented geometric allocation
approximation rather than an identified coefficient.

This is more appropriate for a BlueROV2 than the generic control-surface model,
but it does not reproduce individual thruster geometry, PWM mapping, tether force,
battery voltage sag, or a flight-controller implementation.

## Remaining validation boundary

- No weapon or torpedo coefficient set is included.
- No CFD mesh, tank-test dataset, or site-specific system identification is bundled.
- The diagonal damping representation omits cross-coupling terms.
- The source parameters depend on payload, ballast, and vehicle configuration.
- A successful numerical test establishes implementation consistency, not agreement
  with a physical vehicle.
