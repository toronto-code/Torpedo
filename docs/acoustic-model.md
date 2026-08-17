# Synthetic acoustic channel

## Scope

The simulator contains a software-only analytic acoustic channel for generic
underwater tracking experiments. It adds environmental sensitivity and channel
latency without connecting to a hydrophone, navigation system, network feed, or
hardware interface. Every value is configured or seeded inside the run manifest.

It is not an operational sonar model and contains no real torpedo source level,
target strength, beam pattern, waveform, processing gain, or platform coefficient.
The displayed source, target-strength, noise, and directivity values are synthetic
experiment inputs.

## Model

Sound speed uses the Mackenzie empirical polynomial as a function of temperature,
salinity, and mean source/receiver depth. Absorption uses the Thorp approximation
in dB/km. One-way transmission loss is

```text
TL = k log10(r) + alpha(f) r / 1000
```

where `k` is constrained to 10–20 and `r` is metres. The synthetic active-echo
budget is

```text
EL = SL - 2 TL + TS
SNR = EL - (NL - DI)
```

Detection probability is a configurable logistic transition around an SNR
threshold. Delivery time includes `2r/c` propagation plus the existing processing
latency. A separate seeded random stream decides acoustic-channel detection, so it
does not perturb measurement-noise or configured-dropout sequences.

## Public research basis

- NOAA's *Acoustics Measurement Buoy* report derives spherical and cylindrical
  spreading and treats total loss as geometric plus absorption loss:
  https://repository.library.noaa.gov/view/noaa/33668/noaa_33668_DS1.pdf
- The Ocean Acoustics Library BELLHOP documentation describes depth/range sound-
  speed environments, Gaussian beam tracing, Thorp attenuation, and transmission-
  loss outputs: https://oalib-acoustics.org/website_resources/AcousticsToolbox/manual/node61.html
- TEOS-10 is the current thermodynamic standard for seawater properties, including
  sound speed: https://www.teos-10.org/index.htm
- Fossen's marine-craft formulation provides the public generic 6-DOF structural
  basis used to describe rigid-body, added-mass, damping, and hydrostatic terms:
  https://www.fossen.biz/html/marineCraftModel.html
- Prestero's MIT/WHOI thesis documents a civilian REMUS AUV model and field-
  verification methodology. Its coefficients are not copied into this simulator:
  https://core.ac.uk/download/pdf/4429735.pdf

## Validation evidence

Automated tests check finite/plausible sound speed, positive frequency-dependent
absorption, increasing transmission loss with range, proportional two-way delay,
and decreasing detection probability with range. Seeded end-to-end simulation and
replay verification cover deterministic integration with the sensor pipeline.

These are analytic and software validation checks—not field calibration. A real
environment would require measured sound-speed profiles, bathymetry, bottom type,
ambient-noise spectra, platform self-noise, transducer characterization, and
comparison against time-synchronized observations.
