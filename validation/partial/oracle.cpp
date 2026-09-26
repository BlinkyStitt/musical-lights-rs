// Offline harness only: compile against the unmodified pinned deeuu/loudness
// sources. Binary stdin: 853 f64 component powers per frame, in (20 uPa)^2.
#include "support/SignalBank.h"
#include "support/AuditoryTools.h"
#include "modules/WeightSpectrum.h"
#include "modules/MultiSourceRoexBank.h"
#include "modules/SpecificPartialLoudnessMGB1997.h"
#include "modules/InstantaneousLoudness.h"
#include "modules/ARAverager.h"
#include <iostream>
#include <iomanip>
using namespace loudness;
const double edges[] = {0,100,200,300,400,510,630,770,920,1080,1270,1480,1720,2000,2320,2700,3150,3700,4400,5300,6400,7700,9500,12000,15500};
int main(int argc, char**) {
    RealVec frequencies;
    for (int i=1;i<=853;++i) frequencies.push_back(i*48000.0/2048);
    if (argc>1) {
        OME ome(OME::ANSIS342007_MIDDLE_EAR, OME::ANSIS342007_FREEFIELD);
        ome.interpolateResponse(frequencies);
        std::cout << std::setprecision(17);
        for (double d:ome.getResponse()) std::cout << std::pow(10,d/10) << ",\n";
        return 0;
    }
    SignalBank input;
    input.initialize(25,1,853,1,48000);
    input.setCentreFreqs(frequencies); input.setFrameRate(500);
    WeightSpectrum weight(OME::ANSIS342007_MIDDLE_EAR, OME::ANSIS342007_FREEFIELD);
    MultiSourceRoexBank roex(.25);
    SpecificPartialLoudnessMGB1997 partial(false,false);
    InstantaneousLoudness instant(1,false);
    ARAverager temporal(-.001/std::log(1-.045),-.001/std::log(1-.02));
    weight.addTargetModule(roex); roex.addTargetModule(partial);
    partial.addTargetModule(instant); instant.addTargetModule(temporal);
    if (!weight.initialize(input)) return 1;
    double powers[853];
    auto emit = [](double x) { std::cout.write(reinterpret_cast<char*>(&x),8); };
    while (std::cin.read(reinterpret_cast<char*>(powers),sizeof(powers))) {
        input.zeroSignals();
        for (int bin=0;bin<853;++bin) {
            int band=0; while(band<24 && frequencies[bin]>=edges[band+1]) ++band;
            input.setSample(band,0,bin,0,powers[bin]);
        }
        weight.process(input);
        for(int bin=0;bin<853;++bin) {
            double power=0; for(int s=0;s<25;++s) power+=weight.getOutput().getSample(s,0,bin,0);
            emit(power);
        }
        for(int s=0;s<25;++s) for(int f=0;f<149;++f) emit(roex.getOutput().getSample(s,0,f,0));
        for(int s=0;s<24;++s) for(int f=0;f<149;++f) emit(partial.getOutput().getSample(s,0,f,0));
        for(int s=0;s<24;++s) emit(instant.getOutput().getSample(s));
        for(int s=0;s<24;++s) emit(temporal.getOutput().getSample(s));
    }
}
